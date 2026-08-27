import Foundation
import Testing

@testable import Nama

@Suite("Movie Details feature state")
@MainActor
struct MovieDetailsFeatureTests {
  @Test("selecting a Home Movie loads its canonical Details")
  func selectionLoadsCanonicalDetails() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-selected", title: "Selected Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection)

    feature.select(selection, authorization: authorization)

    #expect(feature.state == .loading(selection))
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }
  }

  @Test("a failed refresh preserves canonical Details")
  func failedRefreshPreservesDetails() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-refresh", title: "Refresh Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    feature.refresh()

    #expect(feature.state == .refreshing(details))
    await eventually { await loader.callCount == 2 }
    await loader.resolve(call: 1, with: .failure(MovieDetailsFailure.transportUnavailable))
    await eventually {
      feature.state == .refreshFailed(details, .transportUnavailable)
    }
  }

  @Test("Retry replaces a failed initial load")
  func retryReplacesInitialFailure() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-retry", title: "Retry Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .failure(MovieDetailsFailure.notFound))
    await eventually { feature.state == .failed(selection, .notFound) }

    feature.retry()

    #expect(feature.state == .loading(selection))
    await eventually { await loader.callCount == 2 }
    await loader.resolve(call: 1, with: .success(details))
    await eventually { feature.state == .content(details) }
  }

  @Test("catalog preparation remains a retry-guided state")
  func catalogPreparationRemainsDistinct() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-catalog", title: "Catalog Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(
      call: 0,
      with: .failure(MovieDetailsFailure.catalogNotReady(retryAfterSeconds: 5))
    )

    await eventually {
      feature.state == .catalogNotReady(selection, retryAfterSeconds: 5)
    }
  }

  @Test(
    "initial failures remain distinct",
    arguments: [
      MovieDetailsFailure.notFound,
      .transportUnavailable,
      .authorizationUnavailable,
      .incompatible,
      .namaUnavailable(requestID: "request-safe-123", retryAfterSeconds: nil),
    ]
  )
  func initialFailuresRemainDistinct(_ failure: MovieDetailsFailure) async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-failure", title: "Failure Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .failure(failure))

    await eventually { feature.state == .failed(selection, failure) }
  }

  @Test("a newer Movie selection cancels and rejects stale completion")
  func newerSelectionRejectsStaleCompletion() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let authorization = try movieDetailsAuthorization(generation: 1)
    let first = movieDetailsSelection(identity: "movie-first", title: "First Movie")
    let second = movieDetailsSelection(identity: "movie-second", title: "Second Movie")
    let firstDetails = movieDetailsFixture(selection: first)
    let secondDetails = movieDetailsFixture(selection: second)

    feature.select(first, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    feature.select(second, authorization: authorization)
    await eventually {
      let callCount = await loader.callCount
      let cancellationCount = await loader.cancellationCount
      return callCount == 2 && cancellationCount == 1
    }

    await loader.resolve(call: 1, with: .success(secondDetails))
    await eventually { feature.state == .content(secondDetails) }
    await loader.resolve(call: 0, with: .success(firstDetails))
    await Task.yield()

    #expect(feature.state == .content(secondDetails))
  }

  @Test("leaving Movie Details cancels its active selection")
  func deactivationCancelsSelection() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-leave", title: "Leaving Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }

    feature.deactivate(selection)

    await eventually { await loader.cancellationCount == 1 }
    #expect(feature.state == .idle)
    await loader.resolve(call: 0, with: .success(details))
    await Task.yield()
    #expect(feature.state == .idle)
  }

  @Test("Play emits only the selected opaque canonical Movie identity")
  func playEmitsCanonicalIdentity() async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-play", title: "Playable Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    #expect(feature.play() == MoviePlayIntent(mediaIdentity: selection.identity))
  }

  @Test(
    "unavailable Movies emit no dead Play intent",
    arguments: [
      MediaPlayability.temporarilyUnavailable,
      .noAvailableSource,
    ]
  )
  func unavailableMovieDoesNotEmitPlay(_ playability: MediaPlayability) async throws {
    let loader = ManualMovieDetailsLoader()
    let feature = MovieDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = movieDetailsSelection(identity: "movie-unavailable", title: "Unavailable")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = movieDetailsFixture(selection: selection, playability: playability)

    feature.select(selection, authorization: authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    #expect(feature.play() == nil)
  }
}
