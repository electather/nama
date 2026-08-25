import Foundation
import Observation

private enum OAuthRefreshWaitResult {
  case ready(OAuthAuthorizationStatus, generation: UInt64)
  case retry
  case stop
}

private enum OAuthRefreshRecordResolution {
  case activate(EndpointBoundOAuthTokenRecord)
  case refresh(EndpointBoundOAuthTokenRecord)
  case retry
  case stop
}

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
  private static let refreshAdmissionRetryInterval: TimeInterval = 0.1
  private static let refreshAdmissionRetryDelay: Duration = .seconds(
    refreshAdmissionRetryInterval
  )

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
      switch await waitForRefresh(attempt: currentAttempt) {
      case .retry:
        continue

      case .stop:
        return

      case .ready(let authorization, let generation):
        if await processReadyRefresh(
          authorization: authorization,
          generation: generation,
          refreshOwner: refreshOwner,
          attempt: currentAttempt
        ) {
          continue
        }
        return
      }
    }
  }

  private func processReadyRefresh(
    authorization: OAuthAuthorizationStatus,
    generation: UInt64,
    refreshOwner: UUID,
    attempt currentAttempt: UInt64
  ) async -> Bool {
    guard session.claimRefresh(owner: refreshOwner, generation: generation) else {
      return await waitForRefreshAdmission(attempt: currentAttempt)
    }
    switch await resolveRefreshRecord(
      authorization: authorization,
      generation: generation,
      refreshOwner: refreshOwner,
      attempt: currentAttempt
    ) {
    case .activate(let record):
      await activate(record, attempt: currentAttempt)
      return true

    case .refresh(let record):
      await refresh(
        record,
        attempt: currentAttempt,
        expectedGeneration: generation
      )
      session.releaseRefresh(owner: refreshOwner)
      return true

    case .retry:
      return true

    case .stop:
      return false
    }
  }

  private func waitForRefresh(attempt currentAttempt: UInt64) async -> OAuthRefreshWaitResult {
    guard let authorization = session.authorization else {
      return .stop
    }
    let generation = session.generation
    let delay = max(0, authorization.accessTokenExpiresAt.timeIntervalSince(now()))
    do {
      try await sleep(.seconds(delay))
    } catch {
      return .stop
    }
    guard isCurrent(currentAttempt) else {
      return .stop
    }
    guard
      session.generation == generation,
      session.authorization == authorization
    else {
      return .retry
    }
    return .ready(authorization, generation: generation)
  }

  private func waitForRefreshAdmission(attempt currentAttempt: UInt64) async -> Bool {
    do {
      try await sleep(Self.refreshAdmissionRetryDelay)
      return isCurrent(currentAttempt)
    } catch {
      return false
    }
  }

  private func resolveRefreshRecord(
    authorization: OAuthAuthorizationStatus,
    generation: UInt64,
    refreshOwner: UUID,
    attempt currentAttempt: UInt64
  ) async -> OAuthRefreshRecordResolution {
    let mutationOwner = UUID()
    guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
      session.releaseRefresh(owner: refreshOwner)
      return .stop
    }
    let snapshot = await tokenStore.load()
    guard isCurrent(currentAttempt) else {
      session.releaseMutation(owner: mutationOwner)
      session.releaseRefresh(owner: refreshOwner)
      return .stop
    }
    guard
      session.generation == generation,
      session.authorization == authorization
    else {
      session.releaseMutation(owner: mutationOwner)
      session.releaseRefresh(owner: refreshOwner)
      return .retry
    }
    switch snapshot {
    case .record(let current) where authorization.matches(current):
      session.releaseMutation(owner: mutationOwner)
      return .refresh(current)

    case .record(let current):
      session.releaseMutation(owner: mutationOwner)
      session.releaseRefresh(owner: refreshOwner)
      return .activate(current)

    case .missing, .damaged, .unavailable:
      session.releaseMutation(owner: mutationOwner)
      presentationState = .failed(authorization.endpoint, .tokenStorageUnavailable)
      session.fail(
        status: authorization,
        failure: .tokenStorageUnavailable,
        expectedGeneration: generation
      )
      session.releaseRefresh(owner: refreshOwner)
      return .stop
    }
  }
}
