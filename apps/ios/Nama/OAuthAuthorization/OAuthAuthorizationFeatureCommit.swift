import Foundation

private struct OAuthCommitRollback {
  let record: EndpointBoundOAuthTokenRecord?
  let generation: UInt64
}

extension OAuthAuthorizationFeature {
  private static let mutationRetryInterval: TimeInterval = 0.05
  private static let mutationRetryDelay: Duration = .seconds(mutationRetryInterval)

  func commit(
    _ bundle: OAuthTokenBundle,
    for endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64,
    expectedCurrent: EndpointBoundOAuthTokenRecord? = nil,
    expectedGeneration: UInt64? = nil
  ) async {
    guard
      isCurrent(currentAttempt),
      let record = makeRecord(bundle, for: endpoint),
      await verifyScopedAccess(record, attempt: currentAttempt)
    else {
      return
    }

    let mutationOwner = UUID()
    guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
      return
    }
    guard
      let rollback = await loadCommitRollback(
        owner: mutationOwner,
        endpoint: endpoint,
        attempt: currentAttempt
      ),
      await expectedCurrentMatches(
        expectedCurrent,
        rollback: rollback,
        owner: mutationOwner,
        attempt: currentAttempt,
        expectedGeneration: expectedGeneration
      ),
      await persist(
        record,
        owner: mutationOwner,
        endpoint: endpoint,
        attempt: currentAttempt
      )
    else {
      return
    }

    guard isCurrent(currentAttempt) else {
      await restoreCancelledCommit(record, rollback: rollback)
      session.releaseMutation(owner: mutationOwner)
      return
    }
    session.publish(record)
    session.releaseMutation(owner: mutationOwner)
    presentationState = .authorized(OAuthAuthorizationStatus(record: record))
  }

  private func makeRecord(
    _ bundle: OAuthTokenBundle,
    for endpoint: NamaEndpoint
  ) -> EndpointBoundOAuthTokenRecord? {
    guard
      bundle.expiresIn > 0,
      let material = OAuthTokenMaterial(
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        scope: bundle.scope,
        tokenType: bundle.tokenType
      )
    else {
      presentationState = .failed(endpoint, .invalidResponse)
      return nil
    }
    return EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      accessTokenExpiresAt: now().addingTimeInterval(bundle.expiresIn),
      scope: material.scope,
      tokenType: material.tokenType
    )
  }

  private func verifyScopedAccess(
    _ record: EndpointBoundOAuthTokenRecord,
    attempt currentAttempt: UInt64
  ) async -> Bool {
    do {
      try await scopedAccessVerifier.verify(record)
      return isCurrent(currentAttempt)
    } catch {
      if isCurrent(currentAttempt) {
        presentationState = .failed(record.endpoint, failure(for: error))
      }
      return false
    }
  }

  private func loadCommitRollback(
    owner: UUID,
    endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async -> OAuthCommitRollback? {
    let snapshot = await tokenStore.load()
    guard isCurrent(currentAttempt) else {
      session.releaseMutation(owner: owner)
      return nil
    }
    switch snapshot {
    case .record(let current):
      return OAuthCommitRollback(record: current, generation: session.generation)

    case .missing:
      return OAuthCommitRollback(record: nil, generation: session.generation)

    case .damaged, .unavailable:
      session.releaseMutation(owner: owner)
      presentationState = .failed(endpoint, .tokenStorageUnavailable)
      return nil
    }
  }

  private func expectedCurrentMatches(
    _ expectedCurrent: EndpointBoundOAuthTokenRecord?,
    rollback: OAuthCommitRollback,
    owner: UUID,
    attempt currentAttempt: UInt64,
    expectedGeneration: UInt64?
  ) async -> Bool {
    guard let expectedCurrent, rollback.record != expectedCurrent else {
      return true
    }
    session.releaseMutation(owner: owner)
    if let current = rollback.record {
      await activate(current, attempt: currentAttempt)
    } else {
      presentationState = .failed(expectedCurrent.endpoint, .tokenStorageUnavailable)
      session.fail(
        record: expectedCurrent,
        failure: .tokenStorageUnavailable,
        expectedGeneration: expectedGeneration
      )
    }
    return false
  }

  private func persist(
    _ record: EndpointBoundOAuthTokenRecord,
    owner: UUID,
    endpoint: NamaEndpoint,
    attempt currentAttempt: UInt64
  ) async -> Bool {
    do {
      try await tokenStore.replace(with: record)
      return true
    } catch {
      session.releaseMutation(owner: owner)
      if isCurrent(currentAttempt) {
        presentationState = .failed(endpoint, .tokenStorageUnavailable)
      }
      return false
    }
  }

  private func restoreCancelledCommit(
    _ candidate: EndpointBoundOAuthTokenRecord,
    rollback: OAuthCommitRollback
  ) async {
    do {
      try await tokenStore.restore(rollback.record, ifCurrent: candidate)
    } catch {
      let restoredSnapshot = await tokenStore.load()
      guard !rollbackWasRestored(rollback.record, snapshot: restoredSnapshot) else {
        return
      }
      let rollbackStatus = OAuthAuthorizationStatus(record: rollback.record ?? candidate)
      session.fail(
        status: rollbackStatus,
        failure: .tokenStorageUnavailable,
        expectedGeneration: rollback.generation
      )
    }
  }

  private func rollbackWasRestored(
    _ rollbackRecord: EndpointBoundOAuthTokenRecord?,
    snapshot: OAuthTokenStoreSnapshot
  ) -> Bool {
    switch (rollbackRecord, snapshot) {
    case (nil, .missing):
      true

    case (let expected?, .record(let current)):
      expected == current

    default:
      false
    }
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
        try await sleep(Self.mutationRetryDelay)
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
