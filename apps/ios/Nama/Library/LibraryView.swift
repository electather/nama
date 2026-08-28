import SwiftUI

enum LibraryLayout {
  #if os(tvOS)
    static let cardMaximumWidth: CGFloat = 320
    static let cardMinimumWidth: CGFloat = 260
    static let cardSpacing: CGFloat = 24
    static let contentPadding: CGFloat = 64
    static let gridSpacing: CGFloat = 36
  #else
    static let cardMaximumWidth: CGFloat = 220
    static let cardMinimumWidth: CGFloat = 148
    static let cardSpacing: CGFloat = 16
    static let contentPadding: CGFloat = 24
    static let gridSpacing: CGFloat = 24
  #endif

  static let loadingItemCount = 12
  static let metadataSpacing: CGFloat = 6
  static let posterHeightUnits: CGFloat = 3
  static let posterWidthUnits: CGFloat = 2
  static let posterAspectRatio = posterWidthUnits / posterHeightUnits
  static let posterCornerRadius: CGFloat = 12
  static let sectionSpacing: CGFloat = 20
  static let titleLineLimit = 3
}

@MainActor
struct LibraryArtworkPresentationAccess {
  let presentationState: (MediaIdentity) -> HomeArtworkPresentationState?
  let didAppear: (MediaIdentity, ArtworkSizeBucket) -> Void
  let didDisappear: (MediaIdentity) -> Void

  static var empty: Self {
    Self(
      presentationState: { _ in nil },
      didAppear: { _, _ in
        // Preview presentations do not schedule artwork.
      },
      didDisappear: { _ in
        // Preview presentations do not schedule artwork.
      }
    )
  }
}

struct LibraryView: View {
  let feature: LibraryFeature
  let search: LibrarySearchFeature
  let authorization: HomeAuthorizationIdentity
  let query: LibraryQuery
  let updateKind: @MainActor (LibraryKind) -> Void
  let updateSort: @MainActor (LibrarySort) -> Void
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    @Bindable var searchBinding = search
    LibrarySearchableContent(
      feature: feature,
      search: search,
      query: query,
      updateKind: updateKind,
      updateSort: updateSort,
      selectMedia: selectMedia,
      changeEndpoint: changeEndpoint,
      reauthorize: reauthorize
    )
    .searchable(text: $searchBinding.text, prompt: "Search your library")
    .onAppear {
      feature.updateQuery(query)
      feature.activate(authorization)
      search.activate(authorization)
    }
    .onChange(of: query) { _, newQuery in
      feature.updateQuery(newQuery)
    }
  }
}

struct LibraryPresentationView: View {
  let state: LibraryState
  let query: LibraryQuery
  let searchState: LibrarySearchState
  let searchIsPresented: Bool
  let updateKind: @MainActor (LibraryKind) -> Void
  let updateSort: @MainActor (LibrarySort) -> Void
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let loadMore: @MainActor () -> Void
  let retryPage: @MainActor () -> Void
  let itemDidAppear: @MainActor (MediaIdentity) -> Void
  let clearSearch: @MainActor () -> Void
  let retrySearch: @MainActor () -> Void
  let refreshSearch: @MainActor () -> Void
  let loadMoreSearch: @MainActor () -> Void
  let retrySearchPage: @MainActor () -> Void
  let searchItemDidAppear: @MainActor (MediaIdentity) -> Void
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: LibraryArtworkPresentationAccess
  let searchArtwork: LibraryArtworkPresentationAccess

  var body: some View {
    VStack(spacing: 0) {
      if searchIsPresented {
        LibrarySearchPresentationView(
          state: searchState,
          selectMedia: selectMedia,
          clear: clearSearch,
          retry: retrySearch,
          refresh: refreshSearch,
          loadMore: loadMoreSearch,
          retryPage: retrySearchPage,
          itemDidAppear: searchItemDidAppear,
          reauthorize: reauthorize,
          artwork: searchArtwork
        )
      } else {
        browseContent
      }
    }
    .navigationTitle("Library")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        if canRefresh {
          Button("Refresh", systemImage: "arrow.clockwise", action: refreshActiveContent)
            .disabled(isRefreshing)
            #if os(macOS)
              .keyboardShortcut("r", modifiers: .command)
            #endif
        }
      }
      if !searchIsPresented {
        ToolbarItem(placement: changeEndpointPlacement) {
          Button("Change Endpoint", systemImage: "network") {
            Task {
              await changeEndpoint()
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  private var browseContent: some View {
    LibraryControls(
      query: query,
      updateKind: updateKind,
      updateSort: updateSort
    )
    Divider()
    LibraryStateContent(
      state: state,
      query: query,
      selectMedia: selectMedia,
      retry: retry,
      refresh: refresh,
      loadMore: loadMore,
      retryPage: retryPage,
      itemDidAppear: itemDidAppear,
      reauthorize: reauthorize,
      artwork: artwork
    )
  }

  private var canRefresh: Bool {
    searchIsPresented
      ? librarySearchCanRefresh(searchState)
      : libraryCanRefresh(state)
  }

  private var isRefreshing: Bool {
    searchIsPresented
      ? librarySearchIsRefreshing(searchState)
      : libraryIsRefreshing(state)
  }

  private func refreshActiveContent() {
    if searchIsPresented {
      refreshSearch()
    } else {
      refresh()
    }
  }

  private var changeEndpointPlacement: ToolbarItemPlacement {
    #if os(tvOS)
      .automatic
    #else
      .secondaryAction
    #endif
  }
}

private struct LibraryControls: View {
  let query: LibraryQuery
  let updateKind: @MainActor (LibraryKind) -> Void
  let updateSort: @MainActor (LibrarySort) -> Void

  var body: some View {
    HStack(spacing: LibraryLayout.sectionSpacing) {
      Picker(
        "Kind",
        selection: Binding(
          get: { query.kind },
          set: { kind in updateKind(kind) }
        )
      ) {
        Text("Movies").tag(LibraryKind.movies)
        Text("Shows").tag(LibraryKind.shows)
      }
      .pickerStyle(.segmented)

      Picker(
        "Sort",
        selection: Binding(
          get: { query.sort },
          set: { sort in updateSort(sort) }
        )
      ) {
        Text("Title").tag(LibrarySort.title)
        Text("Release Date").tag(LibrarySort.releaseDate)
        Text("Date Added").tag(LibrarySort.dateAdded)
      }
      .pickerStyle(.menu)
    }
    .padding(.horizontal, LibraryLayout.contentPadding)
    .padding(.vertical, LibraryLayout.sectionSpacing)
  }
}

private struct LibraryStateContent: View {
  let state: LibraryState
  let query: LibraryQuery
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
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
    case .loading:
      LibraryLoadingView()

    case .catalogNotReady(let retryAfterSeconds):
      ContentUnavailableView {
        Label("Your library is being prepared", systemImage: "clock.arrow.circlepath")
      } description: {
        HomeRetryGuidance(retryAfterSeconds: retryAfterSeconds)
      } actions: {
        Button("Retry", action: retry)
          .buttonStyle(.borderedProminent)
      }

    case .empty:
      ContentUnavailableView {
        Label("Your library is empty", systemImage: "rectangle.stack")
      } description: {
        Text("Refresh to check for newly available movies and shows.")
      } actions: {
        Button("Refresh", action: refresh)
          .buttonStyle(.borderedProminent)
      }

    case .content(let snapshot):
      LibraryContentView(
        snapshot: snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: nil,
        selectMedia: selectMedia,
        refresh: refresh,
        loadMore: loadMore,
        retryPage: retryPage,
        itemDidAppear: itemDidAppear,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshing(let snapshot):
      LibraryContentView(
        snapshot: snapshot,
        isRefreshing: true,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: nil,
        selectMedia: selectMedia,
        refresh: refresh,
        loadMore: loadMore,
        retryPage: retryPage,
        itemDidAppear: itemDidAppear,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshFailed(let snapshot, let failure):
      LibraryContentView(
        snapshot: snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: failure,
        pageFailure: nil,
        selectMedia: selectMedia,
        refresh: refresh,
        loadMore: loadMore,
        retryPage: retryPage,
        itemDidAppear: itemDidAppear,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .loadingMore(let snapshot):
      LibraryContentView(
        snapshot: snapshot,
        isRefreshing: false,
        isLoadingMore: true,
        refreshFailure: nil,
        pageFailure: nil,
        selectMedia: selectMedia,
        refresh: refresh,
        loadMore: loadMore,
        retryPage: retryPage,
        itemDidAppear: itemDidAppear,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .pageFailed(let snapshot, let failure):
      LibraryContentView(
        snapshot: snapshot,
        isRefreshing: false,
        isLoadingMore: false,
        refreshFailure: nil,
        pageFailure: failure,
        selectMedia: selectMedia,
        refresh: refresh,
        loadMore: loadMore,
        retryPage: retryPage,
        itemDidAppear: itemDidAppear,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .failed(let failure):
      LibraryInitialFailureView(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}
