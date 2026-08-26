import Foundation

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

    switch snapshot {
    case .missing:
      session.fail(
        status: rejected,
        failure: .authorizationExpired,
        expectedGeneration: generation
      )
      session.releaseMutation(owner: mutationOwner)
      return .discarded

    case .damaged(let data):
      do {
        try await tokenStore.quarantine(data)
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

    case .unavailable:
      return deferDiscard(
        rejected,
        generation: generation,
        mutationOwner: mutationOwner
      )

    case .record(let current):
      guard rejected.matches(current) else {
        session.releaseMutation(owner: mutationOwner)
        return .stale
      }
      do {
        try await tokenStore.remove(ifCurrent: current)
      } catch {
        return deferDiscard(
          rejected,
          generation: generation,
          mutationOwner: mutationOwner
        )
      }
      session.fail(
        record: current,
        failure: .authorizationExpired,
        expectedGeneration: generation
      )
      session.releaseMutation(owner: mutationOwner)
      return .discarded
    }
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

    switch snapshot {
    case .missing:
      return finishPendingDiscard(context, mutationOwner: mutationOwner)

    case .damaged(let data):
      do {
        try await tokenStore.quarantine(data)
      } catch {
        presentationState = .failed(endpoint, .authorizationResetUnavailable)
        session.releaseMutation(owner: mutationOwner)
        return .storageUnavailable
      }
      return finishPendingDiscard(context, mutationOwner: mutationOwner)

    case .unavailable:
      presentationState = .failed(endpoint, .authorizationResetUnavailable)
      session.releaseMutation(owner: mutationOwner)
      return .storageUnavailable

    case .record(let current):
      guard context.authorization.matches(current) else {
        return finishPendingDiscard(context, mutationOwner: mutationOwner)
      }
      do {
        try await tokenStore.remove(ifCurrent: current)
      } catch {
        presentationState = .failed(endpoint, .authorizationResetUnavailable)
        session.releaseMutation(owner: mutationOwner)
        return .storageUnavailable
      }
      return finishPendingDiscard(context, mutationOwner: mutationOwner)
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
