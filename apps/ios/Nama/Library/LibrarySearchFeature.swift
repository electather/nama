import Foundation
import Observation

@MainActor
@Observable
final class LibrarySearchFeature {
  private static let pageLookahead = 2
  static let artworkCollection = MediaArtworkCollectionIdentity("library-search")

  var text = "" {
    didSet {
      guard text != oldValue else {
        return
      }
      searchTextDidChange()
    }
  }
  var state: LibrarySearchState = .idle

  @ObservationIgnored let loader: any LibrarySearchPageLoading
  @ObservationIgnored let artworkWindow: MediaArtworkWindow
  @ObservationIgnored let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored var activeTask: Task<Void, Never>?
  @ObservationIgnored var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored var attempt: UInt64 = .zero
  @ObservationIgnored var continuationTracker = MediaContinuationTracker()
  @ObservationIgnored var recoverySnapshot: LibrarySearchSnapshot?
  @ObservationIgnored var recoveryVisibleSnapshot: LibrarySearchSnapshot?

  init(
    loader: any LibrarySearchPageLoading,
    artworkLoader: any HomeArtworkLoading,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    self.loader = loader
    artworkWindow = MediaArtworkWindow(loader: artworkLoader)
    self.sleep = sleep
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
    guard normalizedQuery != nil else {
      state = .idle
      return
    }
    startFirstPage(preserving: nil, debounced: true)
  }

  func clear() {
    text = ""
  }

  func retry() {
    guard authorization != nil, normalizedQuery != nil else {
      return
    }
    startFirstPage(preserving: nil, debounced: false)
  }

  func refresh() {
    guard authorization != nil, normalizedQuery != nil else {
      return
    }
    startFirstPage(preserving: confirmedSnapshot, debounced: false)
  }

  func loadMore() {
    guard
      activeTask == nil,
      let snapshot = confirmedSnapshot,
      snapshot.query == normalizedQuery,
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
      librarySearchShouldLoadMore(
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
    artworkWindow.collectionsDidChange([])
    if text.isEmpty {
      state = .idle
    } else {
      text = ""
    }
  }

  func artworkPresentationState(
    for identity: MediaIdentity
  ) -> HomeArtworkPresentationState? {
    artworkWindow.presentationState(for: identity)
  }

  func artworkDidAppear(_ identity: MediaIdentity, size: ArtworkSizeBucket) {
    artworkWindow.artworkDidAppear(identity, in: Self.artworkCollection, size: size)
  }

  func artworkDidDisappear(_ identity: MediaIdentity) {
    artworkWindow.artworkDidDisappear(identity, in: Self.artworkCollection)
  }
}
