import Foundation

private enum OAuthAuthorizationRecordDiscardResult {
  case removedOrAbsent
  case replaced
}

extension OAuthAuthorizationFeature {
  func discardRejectedAuthorization(
    _ rejected: OAuthAuthorizationStatus,
    generation: UInt64
  ) async -> OAuthAuthorizationDiscardResult {
    let currentAttempt = attempt
    guard
      session.generation == generation,
      session.authorization == rejected
    else {
      return .stale
    }
    let mutationOwner = UUID()
    guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
      return .stale
    }
    let snapshot = await tokenStore.load()
    guard
      isCurrent(currentAttempt),
      session.generation == generation,
      session.authorization == rejected
    else {
      session.releaseMutation(owner: mutationOwner)
      return .stale
    }

    do {
      guard
        try await discardAuthorizationRecord(matching: rejected, snapshot: snapshot)
          == .removedOrAbsent
      else {
        session.releaseMutation(owner: mutationOwner)
        return .stale
      }
    } catch {
      return deferDiscard(
        rejected,
        generation: generation,
        mutationOwner: mutationOwner
      )
    }
    session.fail(
      status: rejected,
      failure: .authorizationExpired,
      expectedGeneration: generation
    )
    session.releaseMutation(owner: mutationOwner)
    return .discarded
  }

  private func deferDiscard(
    _ rejected: OAuthAuthorizationStatus,
    generation: UInt64,
    mutationOwner: UUID
  ) -> OAuthAuthorizationDiscardResult {
    let context = session.deferDiscard(
      rejected,
      expectedGeneration: generation
    )
    session.releaseMutation(owner: mutationOwner)
    return context == nil ? .stale : .storageUnavailable
  }

  func resumePendingAuthorizationDiscard(
    at endpoint: NamaEndpoint
  ) async -> OAuthAuthorizationDiscardResult {
    guard
      let context = session.pendingDiscard,
      context.authorization.endpoint == endpoint
    else {
      return .stale
    }
    attempt &+= 1
    let currentAttempt = attempt
    let mutationOwner = UUID()
    guard await acquireMutation(owner: mutationOwner, attempt: currentAttempt) else {
      return .stale
    }
    guard
      isCurrent(currentAttempt),
      session.pendingDiscard == context
    else {
      session.releaseMutation(owner: mutationOwner)
      return .stale
    }
    let snapshot = await tokenStore.load()
    guard
      isCurrent(currentAttempt),
      session.pendingDiscard == context
    else {
      session.releaseMutation(owner: mutationOwner)
      return .stale
    }

    do {
      _ = try await discardAuthorizationRecord(
        matching: context.authorization,
        snapshot: snapshot
      )
    } catch {
      presentationState = .failed(endpoint, .authorizationResetUnavailable)
      session.releaseMutation(owner: mutationOwner)
      return .storageUnavailable
    }
    return finishPendingDiscard(context, mutationOwner: mutationOwner)
  }

  private func discardAuthorizationRecord(
    matching authorization: OAuthAuthorizationStatus,
    snapshot: OAuthTokenStoreSnapshot
  ) async throws -> OAuthAuthorizationRecordDiscardResult {
    switch snapshot {
    case .missing:
      return .removedOrAbsent

    case .damaged(let data):
      try await tokenStore.quarantine(data)
      return .removedOrAbsent

    case .unavailable:
      throw OAuthTokenStoreError.unavailable

    case .record(let current):
      guard authorization.matches(current) else {
        return .replaced
      }
      try await tokenStore.remove(ifCurrent: current)
      return .removedOrAbsent
    }
  }

  private func finishPendingDiscard(
    _ context: OAuthAuthorizationDiscardContext,
    mutationOwner: UUID
  ) -> OAuthAuthorizationDiscardResult {
    let finished = session.finishDiscard(context)
    session.releaseMutation(owner: mutationOwner)
    return finished ? .discarded : .stale
  }
}
