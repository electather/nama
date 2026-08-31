import Testing

@testable import Nama

@Suite("Movie Details presentation projection")
@MainActor
struct MovieDetailsProjectionTests {
  @Test("Details prefers textless artwork and bounds initial Cast")
  func artworkAndCreditProjection() {
    let selection = movieDetailsSelection(identity: "movie-projection", title: "Projection Movie")
    let cast = (0..<MovieDetailsFeatureFixture.castCount).map { index in
      MediaCredit(
        identity: MediaCreditIdentity(index + 1),
        name: "Actor \(index)",
        role: .actor,
        characterName: "Character \(index)",
        portraitArtwork: nil
      )
    }
    let credits = movieProjectionCredits(cast: cast)

    let artwork = [
      movieArtwork(identity: "poster-with-text", role: .poster, textPresence: .containsText),
      movieArtwork(identity: "backdrop-fallback", role: .backdrop, textPresence: .unknown),
      movieArtwork(identity: "poster-textless", role: .poster, textPresence: .textless),
      movieArtwork(identity: "backdrop-textless", role: .backdrop, textPresence: .textless),
    ]
    let details = movieDetailsFixture(
      selection: selection,
      credits: credits,
      artwork: artwork
    )

    #expect(details.directors.map(\.name) == ["Ada Director"])
    #expect(details.writers.map(\.name) == ["Wes Writer"])
    #expect(details.initialCast.count == MovieDetailsFeatureFixture.initialCastLimit)
    #expect(
      details.initialCast.map(\.name)
        == cast.prefix(MovieDetailsFeatureFixture.initialCastLimit).map(\.name)
    )
    #expect(details.credits == credits)
    #expect(details.preferredPosterArtwork?.identity == ArtworkIdentity("poster-textless"))
    #expect(details.preferredBackdropArtwork?.identity == ArtworkIdentity("backdrop-textless"))
    #expect(movieDetailsFixture(selection: selection).preferredBackdropArtwork == nil)
  }

  @Test("Details backdrop requests preserve a sixteen-by-nine size")
  func backdropSizeBucket() {
    let bucket = ArtworkSizeBucket.backdrop(
      displayWidth: MovieDetailsFeatureFixture.backdropDisplayWidth,
      scale: MovieDetailsFeatureFixture.backdropDisplayScale
    )

    #expect(bucket.maxWidth == MovieDetailsFeatureFixture.backdropPixelWidth)
    #expect(bucket.maxHeight == MovieDetailsFeatureFixture.backdropPixelHeight)
  }

  @Test("authorization refresh failure exposes only reauthorization")
  func authorizationRefreshRecovery() {
    let details = movieDetailsFixture(
      selection: movieDetailsSelection(
        identity: "movie-refresh-recovery",
        title: "Refresh Recovery"
      )
    )

    #expect(
      !mediaDetailsCanRefresh(
        .refreshFailed(details, .authorizationUnavailable)
      )
    )
    #expect(
      mediaDetailsCanRefresh(
        .refreshFailed(details, .transportUnavailable)
      )
    )
    #expect(mediaDetailsCanRefresh(.content(details)))
  }

  @Test("Retry receives initial television focus before Sources")
  func televisionRetryPrecedesSourcesFocus() {
    #expect(
      mediaDetailsDefaultFocusAction(
        playability: .temporarilyUnavailable,
        hasSources: true,
        isRefreshing: false,
        canRetryUnavailableSource: true
      ) == .retry
    )
    #expect(
      mediaDetailsDefaultFocusAction(
        playability: .temporarilyUnavailable,
        hasSources: true,
        isRefreshing: true,
        canRetryUnavailableSource: true
      ) == .sources
    )
  }
}

private func movieProjectionCredits(cast: [MediaCredit]) -> [MediaCredit] {
  var credits: [MediaCredit] = []
  credits.append(
    MediaCredit(
      identity: MediaCreditIdentity(0),
      name: "Ada Director",
      role: .director,
      characterName: nil,
      portraitArtwork: nil
    )
  )
  credits.append(contentsOf: cast)
  credits.append(
    MediaCredit(
      identity: MediaCreditIdentity(MovieDetailsFeatureFixture.castCount + 1),
      name: "Wes Writer",
      role: .writer,
      characterName: nil,
      portraitArtwork: nil
    )
  )
  return credits
}
