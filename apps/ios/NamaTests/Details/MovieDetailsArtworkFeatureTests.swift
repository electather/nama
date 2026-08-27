import Testing

@testable import Nama

@Suite("Movie Details artwork feature")
@MainActor
struct MovieDetailsArtworkFeatureTests {
  @Test("failed artwork loading preserves title-bearing Details")
  func artworkFailurePreservesDetails() async throws {
    let loader = ManualMovieDetailsLoader()
    let artworkLoader = MissingMovieDetailsArtworkLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: artworkLoader
    )
    let selection = movieDetailsSelection(identity: "movie-artwork", title: "Artwork Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(
      selection: selection,
      artwork: [
        movieArtwork(identity: "poster", role: .poster, textPresence: .textless)
      ]
    )

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    feature.artworkDidAppear(.poster, size: movieDetailsPosterSize())

    await eventually { await artworkLoader.callCount == 1 }
    #expect(feature.artworkPresentation(for: .poster) == nil)
    #expect(feature.state == .content(details))
  }

  @Test("refresh keeps an in-flight artwork result for the same Movie")
  func refreshKeepsCurrentArtworkLoad() async throws {
    let loader = ManualMovieDetailsLoader()
    let artworkLoader = ManualMovieDetailsArtworkLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: artworkLoader
    )
    let selection = movieDetailsSelection(identity: "movie-artwork-refresh", title: "Artwork")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(
      selection: selection,
      artwork: [
        movieArtwork(identity: "poster-refresh", role: .poster, textPresence: .textless)
      ]
    )

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }
    feature.artworkDidAppear(.poster, size: movieDetailsPosterSize())
    await eventually { await artworkLoader.callCount == 1 }

    feature.refresh()
    await eventually { await loader.callCount == 2 }
    await artworkLoader.resolve(call: 0, with: ArtworkFixture.presentation)

    await eventually { feature.artworkPresentation(for: .poster) != nil }
    await loader.resolve(call: 1, with: .success(details))
    await eventually { feature.state == .content(details) }
  }

  @Test("refresh to missing artwork restores the title fallback")
  func refreshToMissingArtworkClearsPresentation() async throws {
    let loader = ManualMovieDetailsLoader()
    let artworkLoader = ManualMovieDetailsArtworkLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: artworkLoader
    )
    let selection = movieDetailsSelection(identity: "movie-artwork-missing", title: "Fallback")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(
      selection: selection,
      artwork: [
        movieArtwork(identity: "poster-present", role: .poster, textPresence: .textless)
      ]
    )
    let missingArtwork = movieDetailsFixture(selection: selection, artwork: [])

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }
    feature.artworkDidAppear(.poster, size: movieDetailsPosterSize())
    await eventually { await artworkLoader.callCount == 1 }
    await artworkLoader.resolve(call: 0, with: ArtworkFixture.presentation)
    await eventually { feature.artworkPresentation(for: .poster) != nil }

    feature.refresh()
    await eventually { await loader.callCount == 2 }
    await loader.resolve(call: 1, with: .success(missingArtwork))
    await eventually { feature.state == .content(missingArtwork) }
    feature.artworkDidAppear(.poster, size: movieDetailsPosterSize())

    #expect(feature.artworkPresentation(for: .poster) == nil)
  }
}

private func movieDetailsPosterSize() -> HomeArtworkSizeBucket {
  .poster(
    displayWidth: MovieDetailsFeatureFixture.posterDisplayWidth,
    scale: MovieDetailsFeatureFixture.posterDisplayScale
  )
}
