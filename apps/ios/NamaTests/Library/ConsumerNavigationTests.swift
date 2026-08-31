import Testing

@testable import Nama

@Suite("Authorized consumer navigation")
@MainActor
struct ConsumerNavigationTests {
  @Test("new and damaged scene state opens Home with the first Library defaults")
  func safeDefaults() {
    let fresh = ConsumerSceneNavigation(restoration: .default)
    #expect(fresh.topLevel == .home)
    #expect(fresh.libraryQuery == .initial)
    #expect(fresh.homePath.isEmpty)
    #expect(fresh.libraryPath.isEmpty)

    let damaged = ConsumerSceneNavigation(
      restoration: ConsumerSceneRestoration(
        topLevelRawValue: "search",
        libraryKindRawValue: "episodes",
        librarySortRawValue: "opaque-id",
        selectedMediaID: ""
      )
    )
    #expect(damaged.topLevel == .home)
    #expect(damaged.libraryQuery == .initial)
    #expect(damaged.homePath.isEmpty)
    #expect(damaged.libraryPath.isEmpty)
  }

  @Test("scene restoration retains only destination, browse controls, and an opaque ID")
  func restorationReloadsOpaqueSelection() throws {
    let restoration = ConsumerSceneRestoration(
      topLevelRawValue: ConsumerTopLevelDestination.library.rawValue,
      libraryKindRawValue: LibraryKind.shows.rawValue,
      librarySortRawValue: LibrarySort.dateAdded.rawValue,
      selectedMediaID: "opaque/show:id?unchanged"
    )
    let navigation = ConsumerSceneNavigation(restoration: restoration)

    #expect(navigation.topLevel == .library)
    #expect(navigation.libraryQuery == LibraryQuery(kind: .shows, sort: .dateAdded))
    let restored = try #require(navigation.libraryPath.first?.detailsSelection)
    #expect(restored.identity == MediaIdentity("opaque/show:id?unchanged"))
    #expect(restored.kind == nil)
    #expect(restored.title == nil)
    #expect(navigation.restoration == restoration)
  }

  @Test("Sources can nest under Details without changing the restored media")
  func nestedSourcesRetainDetailsRestoration() {
    let navigation = ConsumerSceneNavigation(restoration: .default)
    let details = MediaDetailsSelection(
      identity: MediaIdentity("episode-with-sources"),
      kind: .episode,
      title: "Episode With Sources"
    )
    let sources = MediaSourcesSelection(
      mediaIdentity: details.identity,
      mediaKind: .episode,
      mediaTitle: "Episode With Sources",
      sourceSummaries: []
    )

    navigation.select(details, from: .home)
    navigation.homePath.append(.sources(sources))

    #expect(navigation.homePath == [.details(details), .sources(sources)])
    #expect(navigation.restoration.selectedMediaID == details.identity.rawValue)
  }

  @Test("Home See All opens the matching date-added Library")
  func homeSeeAll() {
    let movies = ConsumerSceneNavigation(restoration: .default)
    movies.showLibrary(for: .movies)
    #expect(movies.topLevel == .library)
    #expect(movies.libraryQuery == LibraryQuery(kind: .movies, sort: .dateAdded))

    let shows = ConsumerSceneNavigation(restoration: .default)
    shows.showLibrary(for: .shows)
    #expect(shows.topLevel == .library)
    #expect(shows.libraryQuery == LibraryQuery(kind: .shows, sort: .dateAdded))
  }

  @Test("each scene owns independent navigation and selection")
  func multiWindowIndependence() {
    let first = ConsumerSceneNavigation(restoration: .default)
    let second = ConsumerSceneNavigation(restoration: .default)
    first.showLibrary(for: .shows)
    first.select(
      MediaDetailsSelection(
        identity: MediaIdentity("first-window-selection"),
        kind: .show,
        title: "First window"
      ),
      from: .library
    )

    #expect(first.topLevel == .library)
    #expect(first.libraryPath.count == 1)
    #expect(second.topLevel == .home)
    #expect(second.libraryQuery == .initial)
    #expect(second.homePath.isEmpty)
    #expect(second.libraryPath.isEmpty)
  }

  @Test(
    "platform families choose their familiar top-level container",
    arguments: [
      (ConsumerPlatformFamily.phone, ConsumerNavigationLayout.tabs),
      (.pad, .split),
      (.television, .tabs),
      (.mac, .split),
    ]
  )
  func platformContainer(
    platform: ConsumerPlatformFamily,
    expected: ConsumerNavigationLayout
  ) {
    #expect(consumerNavigationLayout(for: platform) == expected)
  }
}
