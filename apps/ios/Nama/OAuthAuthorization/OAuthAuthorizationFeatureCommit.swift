import Foundation

extension OAuthAuthorizationFeature {
  func commit(
    _ bundle: OAuthTokenBundle,
    for endpoint: NamaEndpoint,
    expectedCurrent: EndpointBoundOAuthTokenRecord? = nil,
    expectedGeneration: UInt64? = nil,
    attempt currentAttempt: UInt64
  ) async {
    guard isCurrent(currentAttempt) else {
      return
    }
    guard
      !bundle.accessToken.isEmpty,
      !bundle.refreshToken.isEmpty,
      bundle.expiresIn > 0,
      bundle.tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
      Set(bundle.scope) == Set(OAuthConfiguration.consumerScopes),
      bundle.scope.count == OAuthConfiguration.consumerScopes.count
    else {
      presentationState = .failed(endpoint, .invalidResponse)
      return
    }
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: bundle.accessToken,
      refreshToken: bundle.refreshToken,
      accessTokenExpiresAt: now().addingTimeInterval(bundle.expiresIn),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    do {
      try await scopedAccessVerifier.verify(record)
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, failure(for: error))
      }
      return
    }
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
    let rollbackRecord: EndpointBoundOAuthTokenRecord?
    switch snapshot {
    case .record(let current):
      rollbackRecord = current
    case .missing:
      rollbackRecord = nil
    case .damaged, .unavailable:
      session.releaseMutation(owner: mutationOwner)
      presentationState = .failed(endpoint, .tokenStorageUnavailable)
      return
    }
    if let expectedCurrent, rollbackRecord != expectedCurrent {
      session.releaseMutation(owner: mutationOwner)
      if let rollbackRecord {
        await activate(rollbackRecord, attempt: currentAttempt)
      } else {
        presentationState = .failed(endpoint, .tokenStorageUnavailable)
        session.fail(
          record: expectedCurrent,
          failure: .tokenStorageUnavailable,
          expectedGeneration: expectedGeneration
        )
      }
      return
    }
    let rollbackGeneration = session.generation
    do {
      try await tokenStore.replace(with: record)
    } catch {
      session.releaseMutation(owner: mutationOwner)
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, .tokenStorageUnavailable)
      }
      return
    }
    guard isCurrent(currentAttempt) else {
      do {
        try await tokenStore.restore(rollbackRecord, ifCurrent: record)
      } catch {
        let restoredSnapshot = await tokenStore.load()
        let restored: Bool
        switch (rollbackRecord, restoredSnapshot) {
        case (nil, .missing):
          restored = true
        case (let expected?, .record(let current)):
          restored = expected == current
        default:
          restored = false
        }
        if !restored {
          let rollbackStatus: OAuthAuthorizationStatus
          if let rollbackRecord {
            rollbackStatus = OAuthAuthorizationStatus(record: rollbackRecord)
          } else {
            rollbackStatus = OAuthAuthorizationStatus(record: record)
          }
          session.fail(
            status: rollbackStatus,
            failure: .tokenStorageUnavailable,
            expectedGeneration: rollbackGeneration
          )
        }
      }
      session.releaseMutation(owner: mutationOwner)
      return
    }
    session.publish(record)
    session.releaseMutation(owner: mutationOwner)
    presentationState = .authorized(OAuthAuthorizationStatus(record: record))
  }

  func activate(
    _ record: EndpointBoundOAuthTokenRecord,
    attempt currentAttempt: UInt64
  ) async {
    do {
      try await scopedAccessVerifier.verify(record)
    } catch {
      if isCurrent(currentAttempt) {
        let authorizationFailure = failure(for: error)
        presentationState = .failed(record.endpoint, authorizationFailure)
        session.fail(record: record, failure: authorizationFailure)
      }
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
    switch snapshot {
    case .record(let current) where current == record:
      session.publish(record)
      session.releaseMutation(owner: mutationOwner)
      presentationState = .authorized(OAuthAuthorizationStatus(record: record))
    case .record(let current):
      session.releaseMutation(owner: mutationOwner)
      await activate(current, attempt: currentAttempt)
    case .missing, .damaged, .unavailable:
      session.releaseMutation(owner: mutationOwner)
      presentationState = .failed(record.endpoint, .tokenStorageUnavailable)
      session.fail(record: record, failure: .tokenStorageUnavailable)
    }
  }

  func acquireMutation(
    owner: UUID,
    attempt currentAttempt: UInt64
  ) async -> Bool {
    while isCurrent(currentAttempt) {
      if session.claimMutation(owner: owner) {
        return true
      }
      do {
        try await sleep(.seconds(0.05))
      } catch {
        return false
      }
    }
    return false
  }

  func isCurrent(_ currentAttempt: UInt64) -> Bool {
    currentAttempt == attempt && !Task.isCancelled
  }

  func failure(for error: any Error) -> OAuthAuthorizationFailure {
    guard let clientError = error as? OAuthAuthorizationClientError else {
      return .networkUnavailable
    }
    switch clientError {
    case .accessDenied:
      return .accessDenied
    case .expired:
      return .authorizationExpired
    case .invalidGrant, .invalidResponse:
      return .invalidResponse
    case .network:
      return .networkUnavailable
    }
  }
}
