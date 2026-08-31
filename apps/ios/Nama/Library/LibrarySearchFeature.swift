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
  var state: LibrarySearchState {
    librarySearchState(from: paging.state)
  }

  @ObservationIgnored let artworkWindow: MediaArtworkWindow
  @ObservationIgnored private let paging: MediaPagingFeature<String>
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?

  init(
    loader: any LibrarySearchPageLoading,
    artworkLoader: any HomeArtworkLoading,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    let newArtworkWindow = MediaArtworkWindow(loader: artworkLoader)
    artworkWindow = newArtworkWindow
    paging = MediaPagingFeature(
      initialState: .idle,
      load: { query, pageToken, authorization in
        try await loader.loadSearchPage(
          query: query,
          pageToken: pageToken,
          authorization: authorization
        )
      },
      publishItems: { items in
        let collection = MediaArtworkCollection(
          identity: Self.artworkCollection,
          items: items,
          preference: .search
        )
        newArtworkWindow.collectionsDidChange([collection])
      },
      sleep: sleep
    )
  }

  func activate(_ newAuthorization: HomeAuthorizationIdentity) {
    guard authorization != newAuthorization else {
      return
    }
    authorization = newAuthorization
    artworkWindow.authorizationDidChange(to: newAuthorization)
    startFirstPage(preserving: nil, debounced: true)
  }

  func clear() {
    text = ""
  }

  func retry() {
    startFirstPage(preserving: nil, debounced: false)
  }

  func refresh() {
    startFirstPage(preserving: paging.confirmedSnapshot, debounced: false)
  }

  func loadMore() {
    guard let authorization else {
      return
    }
    paging.loadMore(authorization: authorization)
  }

  func retryPage() {
    guard let authorization else {
      return
    }
    paging.retryPage(authorization: authorization)
  }

  func itemDidAppear(_ identity: MediaIdentity) {
    guard let authorization else {
      return
    }
    paging.itemDidAppear(
      identity,
      lookahead: Self.pageLookahead,
      authorization: authorization
    )
  }

  func deactivate() {
    authorization = nil
    artworkWindow.deactivate()
    artworkWindow.collectionsDidChange([])
    if text.isEmpty {
      paging.reset(to: .idle)
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

  private var normalizedQuery: String? {
    let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return query.isEmpty ? nil : query
  }

  private func searchTextDidChange() {
    artworkWindow.collectionsDidChange([])
    startFirstPage(preserving: nil, debounced: true)
  }

  private func startFirstPage(
    preserving snapshot: LibrarySearchSnapshot?,
    debounced: Bool
  ) {
    guard let query = normalizedQuery, let authorization else {
      paging.reset(to: .idle)
      return
    }
    paging.startFirstPage(
      query: query,
      authorization: authorization,
      preserving: snapshot,
      delay: debounced ? LibrarySearchPolicy.debounce : nil
    )
  }
}

private func librarySearchState(
  from state: MediaPagingState<String>
) -> LibrarySearchState {
  switch state {
  case .idle:
    .idle

  case .loading:
    .loading

  case .catalogNotReady(let retryAfterSeconds):
    .catalogNotReady(retryAfterSeconds: retryAfterSeconds)

  case .empty(let query):
    .noResults(query: query)

  case .content(let snapshot):
    .content(snapshot)

  case .refreshing(let snapshot):
    .refreshing(snapshot)

  case .refreshFailed(let snapshot, let failure):
    .refreshFailed(snapshot, failure)

  case .loadingMore(let snapshot):
    .loadingMore(snapshot)

  case .pageFailed(let snapshot, let failure):
    .pageFailed(snapshot, failure)

  case .failed(let failure):
    .failed(failure)
  }
}
