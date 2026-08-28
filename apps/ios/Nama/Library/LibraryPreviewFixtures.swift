#if DEBUG
  import SwiftUI

  nonisolated private enum LibraryPreviewFixtures {
    static let releaseYear: UInt32 = 2_026
    static let homeItemCount = 4
    static let previewEpisodeSeasonNumber: UInt32 = 2
    static let previewEpisodeNumber: UInt32 = 4
    static let searchMovieReleaseYear: UInt32 = 2_024

    static let query = LibraryQuery(kind: .movies, sort: .title)
    static let items = [
      item(
        "movie-one",
        title: "A Deliberately Long Canonical Movie Title That Wraps Without Hiding Its Identity"
      ),
      item("movie-two", title: "Northbound"),
      item("movie-three", title: "The Quiet Archive"),
      item("movie-four", title: "Midnight Index"),
      item("movie-five", title: "Summer Signal"),
      item("movie-six", title: "The Last Provider-Neutral Story"),
      item("movie-seven", title: "One More Shelf"),
      item("movie-eight", title: "Unhurried Light"),
    ]
    static let content = LibrarySnapshot(
      query: query,
      items: items,
      nextPageToken: "preview-page-two"
    )
    static let searchItems = [
      searchItem(
        "episode-one",
        kind: .episode,
        title: "A Deliberately Long Episode Title That Wraps Without Losing Its Place",
        releaseYear: releaseYear,
        playability: .temporarilyUnavailable,
        episodePosition: MediaEpisodePosition(
          seasonNumber: previewEpisodeSeasonNumber,
          episodeNumber: previewEpisodeNumber
        )
      ),
      searchItem(
        "movie-search",
        kind: .movie,
        title: "North Star",
        releaseYear: searchMovieReleaseYear
      ),
      searchItem("season-search", kind: .season, title: "Season Two"),
      searchItem(
        "show-search",
        kind: .show,
        title: "Signals Beyond the Archive",
        playability: .noAvailableSource
      ),
    ]
    static let searchContent = LibrarySearchSnapshot(
      query: "star",
      items: searchItems,
      nextPageToken: "preview-search-page-two"
    )

    static func noAction() {
      // Preview controls intentionally have no side effects.
    }

    static func noKindAction(_: LibraryKind) {
      // Preview controls intentionally have no side effects.
    }

    static func noSortAction(_: LibrarySort) {
      // Preview controls intentionally have no side effects.
    }

    static func noSelectionAction(_: MediaDetailsSelection) {
      // Preview navigation intentionally has no side effects.
    }

    static func noMediaAction(_: MediaIdentity) {
      // Preview visibility intentionally starts no loading work.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

    private static func searchItem(
      _ identity: String,
      kind: MediaKind,
      title: String,
      releaseYear: UInt32? = nil,
      playability: MediaPlayability = .playable,
      episodePosition: MediaEpisodePosition? = nil
    ) -> MediaSummary {
      MediaSummary(
        identity: MediaIdentity(identity),
        kind: kind,
        title: title,
        releaseYear: releaseYear,
        runtime: nil,
        contentRating: nil,
        primaryGenre: nil,
        artwork: [],
        playability: playability,
        defaultSource: nil,
        episodePosition: episodePosition
      )
    }

    private static func item(_ identity: String, title: String) -> MediaSummary {
      MediaSummary(
        identity: MediaIdentity(identity),
        kind: .movie,
        title: title,
        releaseYear: releaseYear,
        runtime: nil,
        contentRating: nil,
        primaryGenre: "Drama",
        artwork: [],
        playability: .playable,
        defaultSource: nil
      )
    }
  }

  private typealias LibraryInspectionLoading =
    HomeLoading & LibraryPageLoading & LibrarySearchPageLoading

  private actor LibraryInspectionLoader: LibraryInspectionLoading {
    func load(for _: HomeAuthorizationIdentity) -> HomeSnapshot {
      HomeSnapshot(
        movies: HomeShelf(
          identity: HomeShelfIdentity("preview-movies"),
          title: "Movies",
          kind: .movies,
          items: Array(LibraryPreviewFixtures.items.prefix(LibraryPreviewFixtures.homeItemCount))
        ),
        shows: nil
      )
    }

    func loadPage(
      query _: LibraryQuery,
      pageToken: String?,
      authorization _: HomeAuthorizationIdentity
    ) -> LibraryPage {
      if pageToken == nil {
        return LibraryPage(
          items: LibraryPreviewFixtures.items,
          nextPageToken: LibraryPreviewFixtures.content.nextPageToken
        )
      }
      return LibraryPage(items: [], nextPageToken: nil)
    }

    func loadSearchPage(
      query _: String,
      pageToken: String?,
      authorization _: HomeAuthorizationIdentity
    ) -> LibrarySearchPage {
      if pageToken == nil {
        return LibrarySearchPage(
          items: LibraryPreviewFixtures.searchItems,
          nextPageToken: LibraryPreviewFixtures.searchContent.nextPageToken
        )
      }
      return LibrarySearchPage(items: [], nextPageToken: nil)
    }
  }

  private typealias LibraryInspectionMediaLoading =
    MediaDetailsLoading & MediaChildrenLoading & MediaSourceLoading

  private actor LibraryInspectionDetailsLoader: LibraryInspectionMediaLoading {
    func load(
      _: MediaDetailsSelection,
      authorization _: HomeAuthorizationIdentity
    ) throws -> MediaDetails {
      throw MediaDetailsFailure.incompatible
    }

    func loadChildren(
      for _: MediaDetailsSelection,
      pageToken _: String?,
      authorization _: HomeAuthorizationIdentity
    ) throws -> MediaChildrenPage {
      throw MediaDetailsFailure.incompatible
    }

    func loadSource(
      mediaIdentity _: MediaIdentity,
      sourceIdentity _: MediaSourceIdentity,
      authorization _: HomeAuthorizationIdentity
    ) throws -> MediaSource {
      throw MediaSourceFailure.incompatible
    }
  }

  private actor LibraryInspectionArtworkLoader: HomeArtworkLoading {
    func authorizationDidChange(to _: HomeAuthorizationIdentity) {
      // Preview artwork has no cache to invalidate.
    }

    func image(
      for _: ArtworkReference,
      size _: ArtworkSizeBucket,
      authorization _: HomeAuthorizationIdentity
    ) -> HomeArtworkPresentation? {
      nil
    }
  }

  @MainActor
  @ViewBuilder
  func authorizedLibraryInspectionPreview() -> some View {
    if let endpoint = try? NamaEndpoint("https://preview.nama.invalid") {
      let loader = LibraryInspectionLoader()
      let detailsLoader = LibraryInspectionDetailsLoader()
      let artworkLoader = LibraryInspectionArtworkLoader()
      let authorization = HomeAuthorizationIdentity(
        endpoint: endpoint,
        accessTokenExpiresAt: .distantFuture,
        generation: .zero
      )
      AuthorizedTopLevelView(
        navigation: ConsumerSceneNavigation(
          restoration: ConsumerSceneRestoration(
            topLevelRawValue: ConsumerTopLevelDestination.library.rawValue,
            libraryKindRawValue: LibraryPreviewFixtures.query.kind.rawValue,
            librarySortRawValue: LibraryPreviewFixtures.query.sort.rawValue,
            selectedMediaID: nil
          )
        ),
        home: HomeFeature(loader: loader, artworkLoader: artworkLoader),
        library: LibraryFeature(loader: loader, artworkLoader: artworkLoader),
        search: LibrarySearchFeature(loader: loader, artworkLoader: artworkLoader),
        authorization: authorization,
        detailsLoader: detailsLoader,
        artworkLoader: artworkLoader,
        emitPlayIntent: { _ in
          // Inspection does not execute playback.
        },
        changeEndpoint: LibraryPreviewFixtures.noAsyncAction,
        reauthorize: LibraryPreviewFixtures.noAsyncAction
      )
    } else {
      ContentUnavailableView("Preview unavailable", systemImage: "exclamationmark.triangle")
    }
  }

  @MainActor
  func libraryInspectionPreview(
    state: LibraryState = .content(LibraryPreviewFixtures.content),
    searchState: LibrarySearchState = .idle,
    searchIsPresented: Bool = false,
    searchText: String = ""
  ) -> some View {
    NavigationStack {
      LibraryPresentationView(
        state: state,
        query: LibraryPreviewFixtures.query,
        searchState: searchState,
        searchIsPresented: searchIsPresented,
        updateKind: LibraryPreviewFixtures.noKindAction,
        updateSort: LibraryPreviewFixtures.noSortAction,
        selectMedia: LibraryPreviewFixtures.noSelectionAction,
        retry: LibraryPreviewFixtures.noAction,
        refresh: LibraryPreviewFixtures.noAction,
        loadMore: LibraryPreviewFixtures.noAction,
        retryPage: LibraryPreviewFixtures.noAction,
        itemDidAppear: LibraryPreviewFixtures.noMediaAction,
        clearSearch: LibraryPreviewFixtures.noAction,
        retrySearch: LibraryPreviewFixtures.noAction,
        refreshSearch: LibraryPreviewFixtures.noAction,
        loadMoreSearch: LibraryPreviewFixtures.noAction,
        retrySearchPage: LibraryPreviewFixtures.noAction,
        searchItemDidAppear: LibraryPreviewFixtures.noMediaAction,
        changeEndpoint: LibraryPreviewFixtures.noAsyncAction,
        reauthorize: LibraryPreviewFixtures.noAsyncAction,
        artwork: .empty,
        searchArtwork: .empty
      )
    }
    .searchable(
      text: .constant(searchText),
      prompt: "Search your library"
    )
  }

  #Preview("Library — Loading") {
    libraryInspectionPreview(state: .loading)
  }

  #Preview("Library — Long Content") {
    libraryInspectionPreview()
  }

  #Preview("Library — Empty") {
    libraryInspectionPreview(state: .empty)
  }

  #Preview("Library — Later Page Failure") {
    libraryInspectionPreview(
      state: .pageFailed(LibraryPreviewFixtures.content, .networkUnavailable)
    )
  }

  #Preview("Library Search — Idle") {
    libraryInspectionPreview(searchIsPresented: true)
  }

  #Preview("Library Search — Loading") {
    libraryInspectionPreview(
      searchState: .loading,
      searchIsPresented: true,
      searchText: "star"
    )
  }

  #Preview("Library Search — Catalog Preparation") {
    libraryInspectionPreview(
      searchState: .catalogNotReady(retryAfterSeconds: 12),
      searchIsPresented: true,
      searchText: "star"
    )
  }

  #Preview("Library Search — Mixed Results") {
    libraryInspectionPreview(
      searchState: .content(LibraryPreviewFixtures.searchContent),
      searchIsPresented: true,
      searchText: LibraryPreviewFixtures.searchContent.query
    )
  }

  #Preview("Library Search — No Results") {
    libraryInspectionPreview(
      searchState: .noResults(query: "missing"),
      searchIsPresented: true,
      searchText: "missing"
    )
  }

  #Preview("Library Search — Failure") {
    libraryInspectionPreview(
      searchState: .failed(.networkUnavailable),
      searchIsPresented: true,
      searchText: "star"
    )
  }

  #Preview("Library Search — Later Page Failure") {
    libraryInspectionPreview(
      searchState: .pageFailed(
        LibraryPreviewFixtures.searchContent,
        .networkUnavailable
      ),
      searchIsPresented: true,
      searchText: LibraryPreviewFixtures.searchContent.query
    )
  }
#endif
