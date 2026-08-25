import Foundation

extension OAuthAuthorizationFeature {
  func beginDeviceAuthorization(
    _ endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async {
    let authorization: OAuthDeviceAuthorization
    do {
      authorization = try await client.requestDeviceAuthorization(at: endpoint)
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, failure(for: error))
      }
      return
    }
    guard isCurrent(currentAttempt) else {
      return
    }
    guard
      !authorization.deviceCode.isEmpty,
      !authorization.userCode.isEmpty,
      authorization.expiresIn > 0,
      authorization.interval > 0
    else {
      presentationState = .failed(endpoint, .invalidResponse)
      return
    }

    presentationState = .awaitingApproval(
      endpoint,
      userCode: authorization.userCode,
      verificationURI: authorization.verificationURI
    )
    let expiresAt = now().addingTimeInterval(authorization.expiresIn)
    var interval = authorization.interval

    while now() < expiresAt, isCurrent(currentAttempt) {
      do {
        try await sleep(.seconds(interval))
      } catch is CancellationError {
        return
      } catch {
        if isCurrent(currentAttempt) {
          presentationState = .failed(endpoint, .networkUnavailable)
        }
        return
      }
      guard isCurrent(currentAttempt) else {
        return
      }

      let pollResult: OAuthTokenPollResult
      do {
        pollResult = try await client.pollToken(
          at: endpoint,
          deviceCode: authorization.deviceCode
        )
      } catch {
        if isCurrent(currentAttempt) {
          presentationState = .failed(endpoint, failure(for: error))
        }
        return
      }
      guard isCurrent(currentAttempt) else {
        return
      }

      switch pollResult {
      case .pending:
        continue
      case .slowDown:
        interval += 5
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
        expectedCurrent: record,
        expectedGeneration: expectedGeneration,
        attempt: currentAttempt
      )
      if case .failed(_, let failure) = presentationState {
        session.fail(
          record: record,
          failure: failure,
          expectedGeneration: expectedGeneration
        )
      }
    } catch OAuthAuthorizationClientError.invalidGrant {
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
    } catch {
      if isCurrent(currentAttempt) {
        let authorizationFailure = failure(for: error)
        presentationState = .failed(record.endpoint, authorizationFailure)
        session.fail(
          record: record,
          failure: authorizationFailure,
          expectedGeneration: expectedGeneration
        )
      }
    }
  }
}
