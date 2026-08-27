import Testing

@testable import Nama

@Suite("Media-kind Details presentation projection")
struct MediaKindProjectionTests {
  @Test("Movie projection exposes only Movie metadata")
  func movieProjection() {
    let details = projectionDetails(
      kindDetails: .movie(
        releaseDate: MediaCalendarDate(year: 2_026, month: 8, day: 25)
      )
    )

    #expect(
      details.presentationMetadata == [
        .releaseDate(MediaCalendarDate(year: 2_026, month: 8, day: 25)),
        .runtime(.seconds(3_600)),
        .contentRating("TV-14"),
        .primaryGenre("Drama"),
      ])
  }

  @Test("Show projection omits runtime and absent aggregate counts")
  func showProjection() {
    let details = projectionDetails(
      kindDetails: .show(
        firstReleaseDate: MediaCalendarDate(year: 2_024, month: 9, day: 12),
        lastReleaseDate: nil,
        seasonCount: 3,
        episodeCount: nil
      )
    )

    #expect(
      details.presentationMetadata == [
        .firstReleaseDate(MediaCalendarDate(year: 2_024, month: 9, day: 12)),
        .seasonCount(3),
        .contentRating("TV-14"),
        .primaryGenre("Drama"),
      ])
  }

  @Test("Season projection omits Movie fields and absent Episode count")
  func seasonProjection() {
    let details = projectionDetails(
      kindDetails: .season(seasonNumber: 3, episodeCount: nil)
    )

    #expect(details.presentationMetadata == [.seasonNumber(3)])
  }

  @Test("Episode projection exposes canonical position, date, and playable metadata")
  func episodeProjection() {
    let details = projectionDetails(
      kindDetails: .episode(
        seasonNumber: 3,
        episodeNumber: 7,
        releaseDate: MediaCalendarDate(year: 2_026, month: 2, day: 19)
      )
    )

    #expect(
      details.presentationMetadata == [
        .seasonNumber(3),
        .episodeNumber(7),
        .releaseDate(MediaCalendarDate(year: 2_026, month: 2, day: 19)),
        .runtime(.seconds(3_600)),
        .contentRating("TV-14"),
        .primaryGenre("Drama"),
      ])
  }

  @Test("child runtime is projected only for Episodes")
  func childRuntimeProjection() {
    let season = projectionSummary(kind: .season)
    let episode = projectionSummary(kind: .episode)

    #expect(season.childRuntime == nil)
    #expect(episode.childRuntime == MediaKindProjectionFixture.runtime)
  }

  @Test("Apple TV keeps one truthful Load More action across page states")
  func televisionPageActionProjection() {
    let item = projectionSummary(kind: .season)

    #expect(
      mediaChildrenTelevisionAction(
        for: .content(items: [item], nextPageToken: "next")
      ) == .loadMore
    )
    #expect(
      mediaChildrenTelevisionAction(
        for: .loadingMore(items: [item], pageToken: "next")
      ) == .loading
    )
    #expect(
      mediaChildrenTelevisionAction(
        for: .pageFailed(
          items: [item],
          pageToken: "next",
          failure: .authorizationUnavailable
        )
      ) == .reauthorize
    )
  }

  @Test(
    "every media kind keeps title-bearing fallback when artwork is absent",
    arguments: [
      MediaDetailsKind.movie(releaseDate: nil),
      .show(
        firstReleaseDate: nil,
        lastReleaseDate: nil,
        seasonCount: nil,
        episodeCount: nil
      ),
      .season(seasonNumber: 1, episodeCount: nil),
      .episode(seasonNumber: 1, episodeNumber: 1, releaseDate: nil),
    ]
  )
  func missingArtworkFallback(_ kindDetails: MediaDetailsKind) {
    let details = projectionDetails(kindDetails: kindDetails)

    #expect(details.preferredPosterArtwork == nil)
    #expect(details.preferredBackdropArtwork == nil)
    #expect(!details.title.isEmpty)
  }
}

private enum MediaKindProjectionFixture {
  static let releaseYear: UInt32 = 2_026
  static let runtimeSeconds: Int64 = 3_600
  static let runtime: Duration = .seconds(runtimeSeconds)
}

private func projectionDetails(kindDetails: MediaDetailsKind) -> MediaDetails {
  MediaDetails(
    identity: MediaIdentity("projection-media"),
    title: "A Canonical Title That Remains Visible Without Artwork",
    releaseYear: MediaKindProjectionFixture.releaseYear,
    runtime: MediaKindProjectionFixture.runtime,
    contentRating: "TV-14",
    primaryGenre: "Drama",
    tagline: nil,
    synopsis: nil,
    genres: [],
    studios: [],
    credits: [],
    artwork: [],
    parents: [],
    playability: .noAvailableSource,
    defaultSource: nil,
    kindDetails: kindDetails
  )
}

private func projectionSummary(kind: MediaKind) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity("projection-child"),
    kind: kind,
    title: "Projection Child",
    releaseYear: nil,
    runtime: MediaKindProjectionFixture.runtime,
    contentRating: nil,
    primaryGenre: nil,
    artwork: [],
    playability: .noAvailableSource,
    defaultSource: nil
  )
}
