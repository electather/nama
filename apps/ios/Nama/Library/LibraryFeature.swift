import Observation

@MainActor
@Observable
final class LibraryFeature {
  private static let pageLookahead = 2

  var query: LibraryQuery = .initial
  var state: LibraryState = .loading

  @ObservationIgnored let loader: any LibraryPageLoading
  @ObservationIgnored let artworkWindow: MediaArtworkWindow
  @ObservationIgnored var activeTask: Task<Void, Never>?
  @ObservationIgnored var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored var attempt: UInt64 = .zero
  @ObservationIgnored var continuationTracker = MediaContinuationTracker()
  @ObservationIgnored var recoverySnapshot: LibrarySnapshot?
  @ObservationIgnored var recoveryVisibleSnapshot: LibrarySnapshot?

  init(loader: any LibraryPageLoading, artworkLoader: any HomeArtworkLoading) {
    self.loader = loader
    artworkWindow = MediaArtworkWindow(loader: artworkLoader)
  }

  deinit {
    activeTask?.cancel()
  }

  func activate(_ newAuthorization: HomeAuthorizationIdentity) {
    guard authorization != newAuthorization else {
      return
    }
    authorization = newAuthorization
    artworkWindow.authorizationDidChange(to: newAuthorization)
    startFirstPage(preserving: nil)
  }

  func updateKind(_ kind: LibraryKind) {
    updateQuery(LibraryQuery(kind: kind, sort: query.sort))
  }

  func updateSort(_ sort: LibrarySort) {
    updateQuery(LibraryQuery(kind: query.kind, sort: sort))
  }

  func refresh() {
    guard authorization != nil else {
      return
    }
    startFirstPage(preserving: confirmedSnapshot)
  }

  func retry() {
    guard authorization != nil else {
      return
    }
    startFirstPage(preserving: nil)
  }

  func loadMore() {
    guard
      activeTask == nil,
      let snapshot = confirmedSnapshot,
      snapshot.query == query,
      snapshot.nextPageToken != nil
    else {
      return
    }
    startPage(from: snapshot)
  }

  func retryPage() {
    guard case .pageFailed(let snapshot, let failure) = state else {
      return
    }
    if failure == .pageTokenInvalid {
      startExpiredPageRecovery(from: snapshot)
    } else if let recoverySnapshot, let recoveryVisibleSnapshot {
      if !continuationTracker.isActive {
        continuationTracker.begin(
          currentPageToken: recoverySnapshot.nextPageToken,
          continuationAllowance: recoveryVisibleSnapshot.items.count
        )
      }
      startRecoveryPage()
    } else {
      startPage(from: snapshot)
    }
  }

  func itemDidAppear(_ identity: MediaIdentity) {
    guard
      libraryShouldLoadMore(
        state: state,
        visibleIdentity: identity,
        lookahead: Self.pageLookahead
      )
    else {
      return
    }
    loadMore()
  }

  func deactivate() {
    authorization = nil
    cancelActiveLoad()
    resetPageRecovery()
    artworkWindow.deactivate()
    state = .loading
  }
}
