import Foundation

struct MediaPagingLoadRequest<Query: Equatable & Sendable> {
  let query: Query
  let pageToken: String?
  let confirmed: MediaPageSnapshot<Query>?
  let kind: MediaPagingLoadKind
  let authorization: HomeAuthorizationIdentity
  let delay: Duration?
}

private struct MediaPagingLoadContext<Query: Equatable & Sendable> {
  let query: Query
  let pageToken: String?
  let confirmed: MediaPageSnapshot<Query>?
  let kind: MediaPagingLoadKind
  let authorization: HomeAuthorizationIdentity
  let attempt: UInt64
}

enum MediaPagingLoadKind {
  case initial
  case refresh
  case page
}

@MainActor
extension MediaPagingFeature {
  func startPage(
    from snapshot: MediaPageSnapshot<Query>,
    authorization: HomeAuthorizationIdentity,
    continuingRecovery: Bool = false
  ) {
    guard let pageToken = snapshot.nextPageToken else {
      return
    }
    if !continuingRecovery {
      resetPageRecovery()
      continuationTracker.begin(
        currentPageToken: pageToken,
        continuationAllowance: snapshot.items.count
      )
    }
    startLoad(
      MediaPagingLoadRequest(
        query: snapshot.query,
        pageToken: pageToken,
        confirmed: snapshot,
        kind: .page,
        authorization: authorization,
        delay: nil
      )
    )
    state = .loadingMore(snapshot)
  }

  func startExpiredPageRecovery(
    from snapshot: MediaPageSnapshot<Query>,
    authorization: HomeAuthorizationIdentity
  ) {
    resetPageRecovery()
    recoveryVisibleSnapshot = snapshot
    recoverySnapshot = MediaPageSnapshot(
      query: snapshot.query,
      items: [],
      nextPageToken: nil
    )
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: snapshot.items.count
    )
    startRecoveryPage(authorization: authorization)
  }

  func startRecoveryPage(authorization: HomeAuthorizationIdentity) {
    guard
      let recoverySnapshot,
      let recoveryVisibleSnapshot
    else {
      return
    }
    startLoad(
      MediaPagingLoadRequest(
        query: recoverySnapshot.query,
        pageToken: recoverySnapshot.nextPageToken,
        confirmed: recoveryVisibleSnapshot,
        kind: .page,
        authorization: authorization,
        delay: nil
      )
    )
    state = .loadingMore(recoveryVisibleSnapshot)
  }

  func startLoad(_ request: MediaPagingLoadRequest<Query>) {
    cancelActiveLoad()
    attempt &+= 1
    let context = MediaPagingLoadContext(
      query: request.query,
      pageToken: request.pageToken,
      confirmed: request.confirmed,
      kind: request.kind,
      authorization: request.authorization,
      attempt: attempt
    )
    let currentLoad = load
    let currentSleep = sleep
    let shouldCheckCancellationBeforeLoad = checksCancellationBeforeLoad
    activeTask = Task { @MainActor [weak self] in
      if let delay = request.delay {
        do {
          try await currentSleep(delay)
        } catch {
          return
        }
      }
      if shouldCheckCancellationBeforeLoad,
        Task.isCancelled
      {
        return
      }
      let result: Result<MediaPage, any Error>
      do {
        result = .success(
          try await currentLoad(
            context.query,
            context.pageToken,
            context.authorization
          )
        )
      } catch {
        result = .failure(error)
      }
      guard !Task.isCancelled else {
        return
      }
      self?.finish(result, context: context)
    }
  }

  private func finish(
    _ result: Result<MediaPage, any Error>,
    context: MediaPagingLoadContext<Query>
  ) {
    guard attempt == context.attempt else {
      return
    }
    activeTask = nil
    switch result {
    case .success(let page):
      publish(page, context: context)

    case .failure(is CancellationError):
      return

    case .failure(let error):
      state = failureState(
        (error as? LibraryLoadingFailure) ?? .incompatible,
        context: context
      )
    }
  }

  private func publish(
    _ page: MediaPage,
    context: MediaPagingLoadContext<Query>
  ) {
    let projection = pageProjection(page, context: context)
    switch continuationTracker.transition(
      pageAddedIdentities: projection.pageAddedIdentities,
      nextPageToken: page.nextPageToken
    ) {
    case .finished:
      recoverySnapshot = nil
      recoveryVisibleSnapshot = nil
      state =
        projection.snapshot.items.isEmpty
        ? .empty(query: projection.snapshot.query)
        : .content(projection.snapshot)
      publishItems(projection.snapshot.items)

    case .loadNext:
      if recoverySnapshot != nil {
        recoverySnapshot = projection.snapshot
        startRecoveryPage(authorization: context.authorization)
      } else {
        publishItems(projection.snapshot.items)
        startPage(
          from: projection.snapshot,
          authorization: context.authorization,
          continuingRecovery: true
        )
      }

    case .incompatible:
      if let recoveryVisibleSnapshot {
        state = .pageFailed(recoveryVisibleSnapshot, .incompatible)
      } else {
        state = .pageFailed(projection.snapshot, .incompatible)
        recoverySnapshot = nil
        recoveryVisibleSnapshot = nil
      }
    }
  }

  private func pageProjection(
    _ page: MediaPage,
    context: MediaPagingLoadContext<Query>
  ) -> (snapshot: MediaPageSnapshot<Query>, pageAddedIdentities: Bool) {
    let baseSnapshot: MediaPageSnapshot<Query>
    if let recoverySnapshot {
      baseSnapshot = recoverySnapshot
    } else if context.kind == .page, let confirmed = context.confirmed {
      baseSnapshot = confirmed
    } else {
      baseSnapshot = MediaPageSnapshot(
        query: context.query,
        items: [],
        nextPageToken: nil
      )
    }
    let items = appendingUniqueMediaSummaries(baseSnapshot.items, page.items)
    let snapshot = MediaPageSnapshot(
      query: context.query,
      items: items,
      nextPageToken: page.nextPageToken
    )
    let pageAddedIdentities: Bool
    if let recoveryVisibleSnapshot {
      let knownItems = appendingUniqueMediaSummaries(
        recoveryVisibleSnapshot.items,
        baseSnapshot.items
      )
      pageAddedIdentities =
        appendingUniqueMediaSummaries(knownItems, page.items).count > knownItems.count
    } else {
      pageAddedIdentities = items.count > baseSnapshot.items.count
    }
    return (snapshot, pageAddedIdentities)
  }

  private func failureState(
    _ failure: LibraryLoadingFailure,
    context: MediaPagingLoadContext<Query>
  ) -> MediaPagingState<Query> {
    if let confirmed = context.confirmed {
      return context.kind == .refresh
        ? .refreshFailed(confirmed, failure)
        : .pageFailed(confirmed, failure)
    }
    if case .catalogNotReady(let retryAfterSeconds) = failure {
      return .catalogNotReady(retryAfterSeconds: retryAfterSeconds)
    }
    return .failed(failure)
  }

  func resetPageRecovery() {
    continuationTracker.reset()
    recoverySnapshot = nil
    recoveryVisibleSnapshot = nil
  }

  func cancelActiveLoad() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
