import Foundation
import Testing

@testable import Nama

@Suite("Home artwork")
struct HomeArtworkTests {
  @Test("selects the first textless poster artwork")
  func selectsTextlessPoster() throws {
    let item = homeArtworkItem(
      artwork: [
        homeArtworkReference(
          identity: "textless-backdrop",
          role: .backdrop,
          textPresence: .textless
        ),
        homeArtworkReference(
          identity: "poster-with-text",
          role: .poster,
          textPresence: .containsText
        ),
        homeArtworkReference(
          identity: "first-textless-poster",
          role: .poster,
          textPresence: .textless
        ),
        homeArtworkReference(
          identity: "second-textless-poster",
          role: .poster,
          textPresence: .textless
        ),
      ]
    )

    let poster = try #require(item.preferredPosterArtwork)
    #expect(poster.identity == ArtworkIdentity("first-textless-poster"))
  }

  @Test("falls back to the first unknown poster when no textless poster exists")
  func selectsUnknownPoster() throws {
    let item = homeArtworkItem(
      artwork: [
        homeArtworkReference(
          identity: "unknown-backdrop",
          role: .backdrop,
          textPresence: .unknown
        ),
        homeArtworkReference(
          identity: "first-unknown-poster",
          role: .poster,
          textPresence: .unknown
        ),
        homeArtworkReference(
          identity: "second-unknown-poster",
          role: .poster,
          textPresence: .unknown
        ),
      ]
    )

    let poster = try #require(item.preferredPosterArtwork)
    #expect(poster.identity == ArtworkIdentity("first-unknown-poster"))
  }

  @Test("rounds a poster request up to a bounded decoded-size bucket")
  func posterSizeBucket() {
    let bucket = artworkSize()

    #expect(bucket.maxWidth == ArtworkFixture.expectedPixelWidth)
    #expect(bucket.maxHeight == ArtworkFixture.expectedPixelHeight)
  }

  @Test("uses platform-appropriate artwork card width")
  func platformCardWidth() {
    #if os(tvOS)
      #expect(HomeArtworkLayout.cardWidth == 300)
    #else
      #expect(HomeArtworkLayout.cardWidth == 148)
    #endif
  }

  @Test("loads one visible poster plus a two-item lookahead")
  @MainActor
  func loadsVisibleArtworkWindow() async throws {
    let items = (1...5).map(homeTextlessPosterItem(number:))
    let snapshot = homeArtworkSnapshot(items: items)
    let artworkLoader = RecordingArtworkLoader()
    let feature = HomeFeature(
      loader: ImmediateArtworkHomeLoader(snapshot: snapshot),
      artworkLoader: artworkLoader
    )
    let authorization = try artworkAuthorization(generation: 1)

    feature.activate(authorization)
    await eventually { feature.state == .content(snapshot) }
    feature.artworkDidAppear(
      items[0].identity,
      in: HomeShelfIdentity("movies"),
      size: artworkSize()
    )
    await eventually { await artworkLoader.requestedIdentities.count == 3 }

    #expect(
      Set(await artworkLoader.requestedIdentities) == [
        ArtworkIdentity("poster-1"),
        ArtworkIdentity("poster-2"),
        ArtworkIdentity("poster-3"),
      ]
    )
  }

  @Test("cancels artwork that leaves the visible lookahead window")
  @MainActor
  func cancelsArtworkOutsideUsefulWindow() async throws {
    let items = (1...5).map(homeTextlessPosterItem(number:))
    let snapshot = homeArtworkSnapshot(items: items)
    let artworkLoader = HoldingArtworkLoader()
    let feature = HomeFeature(
      loader: ImmediateArtworkHomeLoader(snapshot: snapshot),
      artworkLoader: artworkLoader
    )
    let authorization = try artworkAuthorization(generation: 2)

    feature.activate(authorization)
    await eventually { feature.state == .content(snapshot) }
    feature.artworkDidAppear(
      items[0].identity,
      in: HomeShelfIdentity("movies"),
      size: artworkSize()
    )
    await eventually { await artworkLoader.requestCount == 3 }
    feature.artworkDidDisappear(items[0].identity, in: HomeShelfIdentity("movies"))

    await eventually { await artworkLoader.cancellationCount == 3 }
  }

  @Test("keeps the title fallback when no textless poster is safe to load")
  @MainActor
  func keepsTitleFallback() async throws {
    let poster = homeArtworkReference(
      identity: "poster-with-text",
      role: .poster,
      textPresence: .containsText
    )
    let item = homeArtworkItem(artwork: [poster])
    let snapshot = homeArtworkSnapshot(items: [item])
    let artworkLoader = RecordingArtworkLoader()
    let feature = HomeFeature(
      loader: ImmediateArtworkHomeLoader(snapshot: snapshot),
      artworkLoader: artworkLoader
    )

    feature.activate(try artworkAuthorization(generation: 3))
    await eventually { feature.state == .content(snapshot) }
    feature.artworkDidAppear(
      item.identity,
      in: HomeShelfIdentity("movies"),
      size: artworkSize()
    )
    await Task.yield()

    #expect(item.title == "Movie title")
    #expect(await artworkLoader.requestedIdentities.isEmpty)
    #expect(feature.artworkPresentationState(for: item.identity)?.presentation == nil)
  }

  @Test("removes a stale presentation when textless poster artwork disappears")
  @MainActor
  func removesStalePresentation() async throws {
    let initialItem = homeTextlessPosterItem(number: 1)
    let fallbackPoster = homeArtworkReference(
      identity: "poster-with-text",
      role: .poster,
      textPresence: .containsText
    )
    let fallbackItem = homeArtworkItem(
      identity: "movie-1",
      artwork: [fallbackPoster]
    )
    let collection = MediaArtworkCollectionIdentity("movies")
    let window = MediaArtworkWindow(loader: ImmediateArtworkPresentationLoader())
    window.authorizationDidChange(to: try artworkAuthorization(generation: 4))
    window.collectionsDidChange([
      MediaArtworkCollection(identity: collection, items: [initialItem])
    ])
    window.artworkDidAppear(
      initialItem.identity,
      in: collection,
      size: artworkSize()
    )
    await eventually {
      window.presentationState(for: initialItem.identity)?.presentation != nil
    }

    window.collectionsDidChange([
      MediaArtworkCollection(identity: collection, items: [fallbackItem])
    ])

    #expect(window.presentationState(for: initialItem.identity)?.presentation == nil)
  }

  @Test("Search artwork uses an Episode thumbnail without requesting parent media")
  @MainActor
  func searchUsesEpisodeThumbnail() async throws {
    let episode = librarySearchItem(
      "episode",
      kind: .episode,
      title: "Episode",
      episodePosition: MediaEpisodePosition(seasonNumber: 1, episodeNumber: 2),
      artwork: [
        homeArtworkReference(
          identity: "episode-poster",
          role: .poster,
          textPresence: .textless
        ),
        homeArtworkReference(
          identity: "episode-thumbnail",
          role: .thumbnail,
          textPresence: .textless
        ),
      ]
    )
    let collection = MediaArtworkCollectionIdentity("search")
    let loader = RecordingArtworkLoader()
    let window = MediaArtworkWindow(loader: loader)
    window.authorizationDidChange(to: try artworkAuthorization(generation: 5))
    let artworkCollection = MediaArtworkCollection(
      identity: collection,
      items: [episode],
      preference: .search
    )
    window.collectionsDidChange([artworkCollection])

    window.artworkDidAppear(
      episode.identity,
      in: collection,
      size: .thumbnail(displayWidth: 120, scale: 2)
    )
    await eventually { await loader.requestedIdentities.count == 1 }

    #expect(await loader.requestedIdentities == [ArtworkIdentity("episode-thumbnail")])
  }
}

private actor ImmediateArtworkPresentationLoader: HomeArtworkLoading {
  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This test adapter retains no authorization-derived state.
  }

  func image(
    for _: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    ArtworkFixture.presentation
  }
}
