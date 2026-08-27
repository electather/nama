import Foundation
import Testing

@testable import Nama

@Suite("Movie Details presentation projection")
@MainActor
struct MovieDetailsProjectionTests {
  @Test("Details prefers textless artwork and bounds initial Cast")
  func artworkAndCreditProjection() {
    let selection = movieDetailsSelection(identity: "movie-projection", title: "Projection Movie")
    let cast = (0..<MovieDetailsFeatureFixture.castCount).map { index in
      MovieCredit(
        name: "Actor \(index)",
        role: .actor,
        characterName: "Character \(index)",
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
      !movieDetailsCanRefresh(
        .refreshFailed(details, .authorizationUnavailable)
      )
    )
    #expect(
      movieDetailsCanRefresh(
        .refreshFailed(details, .transportUnavailable)
      )
    )
    #expect(movieDetailsCanRefresh(.content(details)))
    #expect(
      !movieDetailsCanRetryUnavailableSource(
        .refreshFailed(details, .authorizationUnavailable)
      )
    )
    #expect(
      movieDetailsCanRetryUnavailableSource(
        .refreshFailed(details, .transportUnavailable)
      )
    )
  }

  @Test("metadata lists follow the active locale")
  func metadataListsFollowLocale() {
    #expect(
      movieDetailsFormattedList(
        ["Ada", "Wes", "Sam"],
        locale: Locale(identifier: "en_US")
      ) == "Ada, Wes, and Sam"
    )
  }
}

private func movieProjectionCredits(cast: [MovieCredit]) -> [MovieCredit] {
  var credits: [MovieCredit] = []
  credits.append(
    MovieCredit(
      name: "Ada Director",
      role: .director,
      characterName: nil,
    )
  )
  credits.append(contentsOf: cast)
  credits.append(
    MovieCredit(
      name: "Wes Writer",
      role: .writer,
      characterName: nil,
    )
  )
  return credits
}
