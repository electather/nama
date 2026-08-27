#if DEBUG
  import SwiftUI

  private enum MovieDetailsPreviewFixtures {
    static let backdropHeight: UInt32 = 1_080
    static let backdropWidth: UInt32 = 1_920
    static let castIdentityOffset = 2
    static let castCount = 10
    static let longSynopsisRepetitions = 40
    static let posterHeight: UInt32 = 1_500
    static let posterWidth: UInt32 = 1_000
    static let releaseDay: Int32 = 25
    static let releaseMonth: Int32 = 8
    static let releaseYear: UInt32 = 2_026
    static let runtimeSeconds: Int64 = 7_200

    static let title = "The Canonical Movie"
    static let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-preview"),
      kind: .movie,
      title: title
    )

    static func noAction() {
      // Preview controls intentionally have no side effects.
    }

    static func noMediaAction(_: MediaIdentity) {
      // Preview child visibility starts no loading work.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

    static func details(
      title: String = Self.title,
      playability: MediaPlayability = .playable,
      includesArtwork: Bool = true,
      synopsis: String? = "A calm provider-neutral synopsis for the selected canonical Movie."
    ) -> MediaDetails {
      let source: MediaSourceSummary?
      switch playability {
      case .playable:
        source = MediaSourceSummary(
          identity: MediaSourceIdentity("source-preview"),
          label: "4K HDR",
          isDefault: true,
          availability: .available,
          container: "mkv",
          videoQuality: nil,
          audioQuality: nil
        )

      case .temporarilyUnavailable:
        source = MediaSourceSummary(
          identity: MediaSourceIdentity("source-preview"),
          label: "4K HDR",
          isDefault: true,
          availability: .providerUnavailable,
          container: "mkv",
          videoQuality: nil,
          audioQuality: nil
        )

      case .noAvailableSource, .unknown:
        source = nil
      }
      return MediaDetails(
        identity: selection.identity,
        title: title,
        releaseYear: releaseYear,
        runtime: .seconds(runtimeSeconds),
        contentRating: "PG-13",
        primaryGenre: "Drama",
        tagline: "Everything changes at midnight.",
        synopsis: synopsis,
        genres: ["Drama", "Mystery"],
        studios: ["North Star Pictures", "Harbor Films"],
        credits: credits,
        artwork: includesArtwork ? artwork : [],
        parents: [],
        playability: playability,
        defaultSource: source,
        sourceSummaries: source.map { [$0] } ?? [],
        kindDetails: .movie(
          releaseDate: MediaCalendarDate(
            year: Int32(releaseYear),
            month: releaseMonth,
            day: releaseDay
          )
        )
      )
    }

    static var longSynopsis: String {
      String(
        repeating: "Every clue changes the meaning of the journey, but the people remain visible. ",
        count: longSynopsisRepetitions
      )
    }

    private static var artwork: [ArtworkReference] {
      [
        ArtworkReference(
          identity: ArtworkIdentity("backdrop-preview"),
          role: .backdrop,
          width: backdropWidth,
          height: backdropHeight,
          locale: nil,
          textPresence: .textless
        ),
        ArtworkReference(
          identity: ArtworkIdentity("poster-preview"),
          role: .poster,
          width: posterWidth,
          height: posterHeight,
          locale: nil,
          textPresence: .textless
        ),
      ]
    }

    private static var credits: [MediaCredit] {
      let cast = (0..<castCount).map { index in
        MediaCredit(
          identity: MediaCreditIdentity(index + castIdentityOffset),
          name: "Cast Member \(index + 1)",
          role: .actor,
          characterName: "Character \(index + 1)",
          portraitArtwork: nil
        )
      }
      return [
        MediaCredit(
          identity: MediaCreditIdentity(0),
          name: "Ada Director",
          role: .director,
          characterName: nil,
          portraitArtwork: nil
        ),
        MediaCredit(
          identity: MediaCreditIdentity(1),
          name: "Wes Writer",
          role: .writer,
          characterName: nil,
          portraitArtwork: nil
        ),
      ] + cast
    }
  }

  @MainActor
  private func mediaDetailsPreview(
    _ state: MediaDetailsState,
    childrenState: MediaChildrenState = .notApplicable
  ) -> some View {
    NavigationStack {
      MediaDetailsPresentationView(
        state: state,
        idleTitle: MovieDetailsPreviewFixtures.selection.title,
        childrenState: childrenState,
        retry: MovieDetailsPreviewFixtures.noAction,
        refresh: MovieDetailsPreviewFixtures.noAction,
        play: MovieDetailsPreviewFixtures.noAction,
        loadMoreChildren: MovieDetailsPreviewFixtures.noAction,
        childDidAppear: MovieDetailsPreviewFixtures.noMediaAction,
        reauthorize: MovieDetailsPreviewFixtures.noAsyncAction,
        artwork: .empty,
        childArtwork: .empty,
        creditArtwork: .empty
      )
    }
  }

  #Preview("Movie Details — Loading") {
    mediaDetailsPreview(.loading(MovieDetailsPreviewFixtures.selection))
  }

  #Preview("Movie Details — Content") {
    mediaDetailsPreview(.content(MovieDetailsPreviewFixtures.details()))
  }

  #Preview("Movie Details — Long synopsis") {
    mediaDetailsPreview(
      .content(
        MovieDetailsPreviewFixtures.details(
          synopsis: MovieDetailsPreviewFixtures.longSynopsis
        )
      )
    )
  }

  #Preview("Movie Details — Missing artwork") {
    mediaDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(includesArtwork: false))
    )
  }

  #Preview("Movie Details — Temporarily unavailable") {
    mediaDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(playability: .temporarilyUnavailable))
    )
  }

  #Preview("Movie Details — No playable source") {
    mediaDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(playability: .noAvailableSource))
    )
  }

  #Preview("Movie Details — Not found") {
    mediaDetailsPreview(
      .failed(MovieDetailsPreviewFixtures.selection, .notFound)
    )
  }
#endif
