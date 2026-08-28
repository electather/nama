import Observation

@MainActor
@Observable
final class LibraryFeature {
  private static let pageLookahead = 2

  var query: LibraryQuery = .initial
  var state: LibraryState {
    libraryState(from: paging.state)
  }

  @ObservationIgnored let artworkWindow: MediaArtworkWindow
  @ObservationIgnored private let paging: MediaPagingFeature<LibraryQuery>
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?

  init(
    loader: any LibraryPageLoading,
    artworkLoader: any HomeArtworkLoading
  ) {
    let newArtworkWindow = MediaArtworkWindow(loader: artworkLoader)
    artworkWindow = newArtworkWindow
    paging = MediaPagingFeature(
      initialState: .loading,
      load: { query, pageToken, authorization in
        try await loader.loadPage(
          query: query,
          pageToken: pageToken,
          authorization: authorization
        )
      },
      publishItems: { items in
        newArtworkWindow.collectionsDidChange(
          LibraryArtworkProjection.collections(items: items)
        )
      },
      checksCancellationBeforeLoad: false
    )
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
    startFirstPage(preserving: paging.confirmedSnapshot)
  }

  func retry() {
    startFirstPage(preserving: nil)
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
    paging.reset(to: .loading)
    artworkWindow.deactivate()
  }

  func updateQuery(_ newQuery: LibraryQuery) {
    guard query != newQuery else {
      return
    }
    query = newQuery
    artworkWindow.collectionsDidChange(LibraryArtworkProjection.collections(items: []))
    startFirstPage(preserving: nil)
  }

  private func startFirstPage(preserving snapshot: LibrarySnapshot?) {
    guard let authorization else {
      paging.reset(to: .loading)
      return
    }
    paging.startFirstPage(
      query: query,
      authorization: authorization,
      preserving: snapshot
    )
  }
}

private func libraryState(
  from state: MediaPagingState<LibraryQuery>
) -> LibraryState {
  switch state {
  case .idle, .loading:
    .loading

  case .catalogNotReady(let retryAfterSeconds):
    .catalogNotReady(retryAfterSeconds: retryAfterSeconds)

  case .empty:
    .empty

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
