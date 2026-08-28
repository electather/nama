import Foundation
import Observation

@MainActor
@Observable
final class MediaPagingFeature<Query: Equatable & Sendable> {
  var state: MediaPagingState<Query>

  @ObservationIgnored let load:
    @Sendable (Query, String?, HomeAuthorizationIdentity) async throws -> MediaPage
  @ObservationIgnored let publishItems: @MainActor ([MediaSummary]) -> Void
  @ObservationIgnored let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored let checksCancellationBeforeLoad: Bool
  @ObservationIgnored var activeTask: Task<Void, Never>?
  @ObservationIgnored var attempt: UInt64 = .zero
  @ObservationIgnored var continuationTracker = MediaContinuationTracker()
  @ObservationIgnored var recoverySnapshot: MediaPageSnapshot<Query>?
  @ObservationIgnored var recoveryVisibleSnapshot: MediaPageSnapshot<Query>?

  init(
    initialState: MediaPagingState<Query>,
    load:
      @escaping @Sendable (
        Query,
        String?,
        HomeAuthorizationIdentity
      ) async throws -> MediaPage,
    publishItems: @escaping @MainActor ([MediaSummary]) -> Void,
    checksCancellationBeforeLoad: Bool = true,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    state = initialState
    self.load = load
    self.publishItems = publishItems
    self.checksCancellationBeforeLoad = checksCancellationBeforeLoad
    self.sleep = sleep
  }

  deinit {
    activeTask?.cancel()
  }

  var confirmedSnapshot: MediaPageSnapshot<Query>? {
    switch state {
    case .content(let snapshot), .refreshing(let snapshot), .refreshFailed(let snapshot, _),
      .loadingMore(let snapshot), .pageFailed(let snapshot, _):
      snapshot

    case .idle, .loading, .catalogNotReady, .empty, .failed:
      nil
    }
  }

  func reset(to state: MediaPagingState<Query>) {
    cancelActiveLoad()
    resetPageRecovery()
    self.state = state
  }

  func startFirstPage(
    query: Query,
    authorization: HomeAuthorizationIdentity,
    preserving snapshot: MediaPageSnapshot<Query>?,
    delay: Duration? = nil
  ) {
    resetPageRecovery()
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: Int(LibraryPagePolicy.size)
    )
    startLoad(
      MediaPagingLoadRequest(
        query: query,
        pageToken: nil,
        confirmed: snapshot,
        kind: snapshot == nil ? .initial : .refresh,
        authorization: authorization,
        delay: delay
      )
    )
    state = snapshot.map(MediaPagingState.refreshing) ?? .loading
  }

  func loadMore(authorization: HomeAuthorizationIdentity) {
    guard
      activeTask == nil,
      let snapshot = confirmedSnapshot,
      snapshot.nextPageToken != nil
    else {
      return
    }
    startPage(from: snapshot, authorization: authorization)
  }

  func retryPage(authorization: HomeAuthorizationIdentity) {
    guard case .pageFailed(let snapshot, let failure) = state else {
      return
    }
    if failure == .pageTokenInvalid {
      startExpiredPageRecovery(from: snapshot, authorization: authorization)
    } else if let recoverySnapshot, let recoveryVisibleSnapshot {
      if !continuationTracker.isActive {
        continuationTracker.begin(
          currentPageToken: recoverySnapshot.nextPageToken,
          continuationAllowance: recoveryVisibleSnapshot.items.count
        )
      }
      startRecoveryPage(authorization: authorization)
    } else {
      startPage(from: snapshot, authorization: authorization)
    }
  }

  func itemDidAppear(
    _ identity: MediaIdentity,
    lookahead: Int,
    authorization: HomeAuthorizationIdentity
  ) {
    guard
      case .content(let snapshot) = state,
      snapshot.nextPageToken != nil,
      let index = snapshot.items.firstIndex(where: { $0.identity == identity }),
      snapshot.items.distance(from: index, to: snapshot.items.endIndex) <= lookahead
    else {
      return
    }
    loadMore(authorization: authorization)
  }
}
