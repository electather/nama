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
    #expect(poster.identity == HomeArtworkIdentity("first-textless-poster"))
  }

  @Test("rounds a poster request up to a bounded decoded-size bucket")
  func posterSizeBucket() {
    let bucket = artworkSize()

    #expect(bucket.maxWidth == ArtworkFixture.expectedPixelWidth)
    #expect(bucket.maxHeight == ArtworkFixture.expectedPixelHeight)
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
        HomeArtworkIdentity("poster-1"),
        HomeArtworkIdentity("poster-2"),
        HomeArtworkIdentity("poster-3"),
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
    let initialSnapshot = homeArtworkSnapshot(items: [initialItem])
    let fallbackSnapshot = homeArtworkSnapshot(items: [fallbackItem])
    let window = HomeArtworkWindow(loader: ImmediateArtworkPresentationLoader())
    window.authorizationDidChange(to: try artworkAuthorization(generation: 4))
    window.snapshotDidChange(initialSnapshot)
    window.artworkDidAppear(
      initialItem.identity,
      in: HomeShelfIdentity("movies"),
      size: artworkSize()
    )
    await eventually {
      window.presentationState(for: initialItem.identity)?.presentation != nil
    }

    window.snapshotDidChange(fallbackSnapshot)

    #expect(window.presentationState(for: initialItem.identity)?.presentation == nil)
  }
}

private actor ImmediateArtworkPresentationLoader: HomeArtworkLoading {
  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This test adapter retains no authorization-derived state.
  }

  func image(
    for _: HomeArtworkReference,
    size _: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    ArtworkFixture.presentation
  }
}
