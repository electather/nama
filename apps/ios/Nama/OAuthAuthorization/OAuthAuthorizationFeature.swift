import Foundation
import Observation

@MainActor
@Observable
final class OAuthAuthorizationFeature {
  var presentationState: OAuthAuthorizationState = .idle

  var state: OAuthAuthorizationState {
    if case .authorized = presentationState {
      if let authorization = session.authorization {
        return .authorized(authorization)
      }
      if let endpoint = session.failureEndpoint, let failure = session.failure {
        return .failed(endpoint, failure)
      }
    }
    return presentationState
  }

  @ObservationIgnored let client: any OAuthAuthorizationClient
  @ObservationIgnored let tokenStore: any OAuthTokenStoring
  @ObservationIgnored let scopedAccessVerifier: any OAuthScopedAccessVerifying
  let session: OAuthAuthorizationSession
  @ObservationIgnored let now: @Sendable () -> Date
  @ObservationIgnored let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored var attempt: UInt64 = 0

  init(
    client: any OAuthAuthorizationClient,
    tokenStore: any OAuthTokenStoring,
    scopedAccessVerifier: any OAuthScopedAccessVerifying,
    session: OAuthAuthorizationSession = OAuthAuthorizationSession(),
    now: @escaping @Sendable () -> Date = Date.init,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    self.client = client
    self.tokenStore = tokenStore
    self.scopedAccessVerifier = scopedAccessVerifier
    self.session = session
    self.now = now
    self.sleep = sleep
  }

  @discardableResult
  func authorize(_ endpoint: NamaEndpoint) async -> UInt64 {
    attempt &+= 1
    let currentAttempt = attempt
    presentationState = .requesting(endpoint)
    let snapshot = await tokenStore.load()
    guard isCurrent(currentAttempt) else {
      return currentAttempt
    }

    switch snapshot {
    case .missing:
      await beginDeviceAuthorization(
        endpoint,
        attempt: currentAttempt
      )

    case .record(let record) where record.endpoint == endpoint:
      if record.accessTokenExpiresAt > now() {
        await activate(record, attempt: currentAttempt)
      } else {
        let expectedGeneration =
          session.authorization?.matches(record) == true ? session.generation : nil
        await refresh(
          record,
          attempt: currentAttempt,
          expectedGeneration: expectedGeneration
        )
      }

    case .record:
      await beginDeviceAuthorization(
        endpoint,
        attempt: currentAttempt
      )

    case .damaged(let data):
      do {
        try await tokenStore.quarantine(data)
      } catch {
        if isCurrent(currentAttempt) {
          presentationState = .failed(endpoint, .tokenStorageUnavailable)
        }
        return currentAttempt
      }
      guard isCurrent(currentAttempt) else {
        return currentAttempt
      }
      await beginDeviceAuthorization(
        endpoint,
        attempt: currentAttempt
      )

    case .unavailable:
      presentationState = .failed(endpoint, .tokenStorageUnavailable)
    }
    return currentAttempt
  }

  func run(_ endpoint: NamaEndpoint) async {
    let currentAttempt = await authorize(endpoint)
    guard case .authorized = presentationState else {
      return
    }
    let refreshOwner = UUID()

    while isCurrent(currentAttempt) {
      guard let authorization = session.authorization else {
        return
      }
      let generation = session.generation
      let delay = max(0, authorization.accessTokenExpiresAt.timeIntervalSince(now()))
      do {
        try await sleep(.seconds(delay))
      } catch {
        return
      }
      guard isCurrent(currentAttempt) else {
        return
      }
      guard
        session.generation == generation,
        session.authorization == authorization
      else {
        continue
      }
      guard session.claimRefresh(owner: refreshOwner, generation: generation) else {
        do {
          try await sleep(.seconds(0.1))
        } catch {
          return
        }
        continue
      }
      let mutationOwner = UUID()
      guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
        session.releaseRefresh(owner: refreshOwner)
        return
      }
      let snapshot = await tokenStore.load()
      guard isCurrent(currentAttempt) else {
        session.releaseMutation(owner: mutationOwner)
        session.releaseRefresh(owner: refreshOwner)
        return
      }
      guard
        session.generation == generation,
        session.authorization == authorization
      else {
        session.releaseMutation(owner: mutationOwner)
        session.releaseRefresh(owner: refreshOwner)
        continue
      }
      let record: EndpointBoundOAuthTokenRecord
      switch snapshot {
      case .record(let current) where authorization.matches(current):
        record = current
        session.releaseMutation(owner: mutationOwner)
      case .record(let current):
        session.releaseMutation(owner: mutationOwner)
        session.releaseRefresh(owner: refreshOwner)
        await activate(current, attempt: currentAttempt)
        continue
      case .missing, .damaged, .unavailable:
        session.releaseMutation(owner: mutationOwner)
        presentationState = .failed(authorization.endpoint, .tokenStorageUnavailable)
        session.fail(
          status: authorization,
          failure: .tokenStorageUnavailable,
          expectedGeneration: generation
        )
        session.releaseRefresh(owner: refreshOwner)
        return
      }
      await refresh(
        record,
        attempt: currentAttempt,
        expectedGeneration: generation
      )
      session.releaseRefresh(owner: refreshOwner)
    }
  }
}
