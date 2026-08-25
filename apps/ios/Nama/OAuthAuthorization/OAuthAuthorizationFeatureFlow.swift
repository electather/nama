import Foundation

extension OAuthAuthorizationFeature {
  private static let pollingSlowDownIncrement: TimeInterval = 5

  func beginDeviceAuthorization(
    _ endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async {
    guard
      let authorization = await requestDeviceAuthorization(
        endpoint,
        attempt: currentAttempt
      )
    else {
      return
    }

    let expiresAt = presentDeviceAuthorization(authorization, endpoint: endpoint)
    var interval = authorization.interval

    while now() < expiresAt, isCurrent(currentAttempt) {
      guard
        await waitForDevicePoll(
          interval: interval,
          endpoint: endpoint,
          attempt: currentAttempt
        ),
        let pollResult = await pollDeviceToken(
          authorization.deviceCode,
          endpoint: endpoint,
          attempt: currentAttempt
        )
      else {
        return
      }

      switch pollResult {
      case .pending:
        continue

      case .slowDown:
        interval += Self.pollingSlowDownIncrement

      case .denied:
        presentationState = .failed(endpoint, .accessDenied)
        return

      case .expired:
        presentationState = .failed(endpoint, .authorizationExpired)
        return

      case .authorized(let bundle):
        await commit(
          bundle,
          for: endpoint,
          attempt: currentAttempt
        )
        return
      }
    }

    if isCurrent(currentAttempt) {
      presentationState = .failed(endpoint, .authorizationExpired)
    }
  }

  private func presentDeviceAuthorization(
    _ authorization: OAuthDeviceAuthorization,
    endpoint: NamaEndpoint
  ) -> Date {
    presentationState = .awaitingApproval(
      endpoint,
      userCode: authorization.userCode,
      verificationURI: authorization.verificationURI
    )
    return now().addingTimeInterval(authorization.expiresIn)
  }

  private func requestDeviceAuthorization(
    _ endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async -> OAuthDeviceAuthorization? {
    do {
      let authorization = try await client.requestDeviceAuthorization(at: endpoint)
      guard isCurrent(currentAttempt) else {
        return nil
      }
      guard
        !authorization.deviceCode.isEmpty,
        !authorization.userCode.isEmpty,
        authorization.expiresIn > 0,
        authorization.interval > 0
      else {
        presentationState = .failed(endpoint, .invalidResponse)
        return nil
      }
      return authorization
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, failure(for: error))
      }
      return nil
    }
  }

  private func waitForDevicePoll(
    interval: TimeInterval,
    endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async -> Bool {
    do {
      try await sleep(.seconds(interval))
      return isCurrent(currentAttempt)
    } catch is CancellationError {
      return false
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, .networkUnavailable)
      }
      return false
    }
  }

  private func pollDeviceToken(
    _ deviceCode: String,
    endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async -> OAuthTokenPollResult? {
    do {
      let result = try await client.pollToken(
        at: endpoint,
        deviceCode: deviceCode
      )
      return isCurrent(currentAttempt) ? result : nil
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, failure(for: error))
      }
      return nil
    }
  }

  func refresh(
    _ record: EndpointBoundOAuthTokenRecord,
    attempt currentAttempt: UInt64,
    expectedGeneration: UInt64? = nil
  ) async {
    do {
      let bundle = try await client.refreshToken(
        at: record.endpoint,
        refreshToken: record.refreshToken
      )
      await commit(
        bundle,
        for: record.endpoint,
        attempt: currentAttempt,
        expectedCurrent: record,
        expectedGeneration: expectedGeneration
      )
      if case .failed(_, let failure) = presentationState {
        session.fail(
          record: record,
          failure: failure,
          expectedGeneration: expectedGeneration
        )
      }
    } catch OAuthAuthorizationClientError.invalidGrant {
      await handleInvalidGrant(
        record,
        attempt: currentAttempt,
        expectedGeneration: expectedGeneration
      )
    } catch {
      failRefresh(
        record,
        error: error,
        attempt: currentAttempt,
        expectedGeneration: expectedGeneration
      )
    }
  }

  private func handleInvalidGrant(
    _ record: EndpointBoundOAuthTokenRecord,
    attempt currentAttempt: UInt64,
    expectedGeneration: UInt64?
  ) async {
    guard isCurrent(currentAttempt) else {
      return
    }
    let mutationOwner = UUID()
    guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
      return
    }
    let snapshot = await tokenStore.load()
    guard isCurrent(currentAttempt) else {
      session.releaseMutation(owner: mutationOwner)
      return
    }
    guard case .record(let current) = snapshot, current == record else {
      session.releaseMutation(owner: mutationOwner)
      if case .record(let current) = snapshot {
        await activate(current, attempt: currentAttempt)
      }
      return
    }
    do {
      try await tokenStore.remove(ifCurrent: record)
    } catch {
      session.releaseMutation(owner: mutationOwner)
      if isCurrent(currentAttempt) {
        presentationState = .failed(record.endpoint, .tokenStorageUnavailable)
        session.fail(
          record: record,
          failure: .tokenStorageUnavailable,
          expectedGeneration: expectedGeneration
        )
      }
      return
    }
    session.fail(
      record: record,
      failure: .invalidResponse,
      expectedGeneration: expectedGeneration
    )
    session.releaseMutation(owner: mutationOwner)
    guard isCurrent(currentAttempt) else {
      return
    }
    await beginDeviceAuthorization(
      record.endpoint,
      attempt: currentAttempt
    )
  }

  private func failRefresh(
    _ record: EndpointBoundOAuthTokenRecord,
    error: any Error,
    attempt currentAttempt: UInt64,
    expectedGeneration: UInt64?
  ) {
    guard isCurrent(currentAttempt) else {
      return
    }
    let authorizationFailure = failure(for: error)
    presentationState = .failed(record.endpoint, authorizationFailure)
    session.fail(
      record: record,
      failure: authorizationFailure,
      expectedGeneration: expectedGeneration
    )
  }
}
