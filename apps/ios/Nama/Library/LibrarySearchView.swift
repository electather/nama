import SwiftUI

struct LibrarySearchableContent: View {
  @Environment(\.isSearching) private var isSearching

  let feature: LibraryFeature
  let search: LibrarySearchFeature
  let query: LibraryQuery
  let updateKind: @MainActor (LibraryKind) -> Void
  let updateSort: @MainActor (LibrarySort) -> Void
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    LibraryPresentationView(
      state: feature.state,
      query: query,
      searchState: search.state,
      searchIsPresented: isSearching,
      updateKind: updateKind,
      updateSort: updateSort,
      selectMedia: selectMedia,
      retry: feature.retry,
      refresh: feature.refresh,
      loadMore: feature.loadMore,
      retryPage: feature.retryPage,
      itemDidAppear: feature.itemDidAppear,
      clearSearch: search.clear,
      retrySearch: search.retry,
      refreshSearch: search.refresh,
      loadMoreSearch: search.loadMore,
      retrySearchPage: search.retryPage,
      searchItemDidAppear: search.itemDidAppear,
      changeEndpoint: changeEndpoint,
      reauthorize: reauthorize,
      artwork: LibraryArtworkPresentationAccess(
        presentationState: feature.artworkPresentationState,
        didAppear: feature.artworkDidAppear,
        didDisappear: feature.artworkDidDisappear
      ),
      searchArtwork: LibraryArtworkPresentationAccess(
        presentationState: search.artworkPresentationState,
        didAppear: search.artworkDidAppear,
        didDisappear: search.artworkDidDisappear
      )
    )
    .onChange(of: isSearching) { _, newValue in
      if !newValue {
        search.clear()
      }
    }
  }
}

struct LibrarySearchPresentationView: View {
  let state: LibrarySearchState
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
  let clear: @MainActor () -> Void
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let loadMore: @MainActor () -> Void
  let retryPage: @MainActor () -> Void
  let itemDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: LibraryArtworkPresentationAccess

  @ViewBuilder
  var body: some View {
    switch state {
    case .idle:
      ContentUnavailableView {
        Label("Search your library", systemImage: "magnifyingglass")
      } description: {
        Text("Find stored movies, shows, seasons, and episodes.")
      }

    case .loading:
      LibrarySearchLoadingView()

    case .catalogNotReady(let retryAfterSeconds):
      ContentUnavailableView {
        Label("Your library is being prepared", systemImage: "clock.arrow.circlepath")
      } description: {
        HomeRetryGuidance(retryAfterSeconds: retryAfterSeconds)
      } actions: {
        Button("Retry", action: retry)
          .buttonStyle(.borderedProminent)
      }

    case .noResults(let query):
      ContentUnavailableView {
        Label("No results", systemImage: "magnifyingglass")
      } description: {
        Text("No stored media matches “\(query)”.")
      } actions: {
        Button("Clear Search", action: clear)
          .buttonStyle(.borderedProminent)
      }

    case .content(let snapshot):
      results(
        snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: nil
      )

    case .refreshing(let snapshot):
      results(
        snapshot,
        isRefreshing: true,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: nil
      )

    case .refreshFailed(let snapshot, let failure):
      results(
        snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: failure,
        pageFailure: nil
      )

    case .loadingMore(let snapshot):
      results(
        snapshot,
        isRefreshing: false,
        isLoadingMore: true,
        refreshFailure: nil,
        pageFailure: nil
      )

    case .pageFailed(let snapshot, let failure):
      results(
        snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: failure
      )

    case .failed(let failure):
      LibrarySearchInitialFailureView(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }

  private func results(
    _ snapshot: LibrarySearchSnapshot,
    isRefreshing: Bool,
    isLoadingMore: Bool,
    refreshFailure: LibraryLoadingFailure?,
    pageFailure: LibraryLoadingFailure?
  ) -> some View {
    LibrarySearchResultsView(
      snapshot: snapshot,
      isRefreshing: isRefreshing,
      isLoadingMore: isLoadingMore,
      refreshFailure: refreshFailure,
      pageFailure: pageFailure,
      selectMedia: selectMedia,
      refresh: refresh,
      loadMore: loadMore,
      retryPage: retryPage,
      itemDidAppear: itemDidAppear,
      reauthorize: reauthorize,
      artwork: artwork
    )
  }
}

struct LibrarySearchKindAndYear: View {
  let item: MediaSummary

  var body: some View {
    if let releaseYear = item.releaseYear {
      Text("\(kindLabel) · \(releaseYear, format: .number.grouping(.never))")
    } else {
      kindLabel
    }
  }

  private var kindLabel: Text {
    switch item.kind {
    case .movie:
      Text("Movie")

    case .show:
      Text("Show")

    case .season:
      Text("Season")

    case .episode:
      Text("Episode")
    }
  }
}
