#if DEBUG
  import SwiftUI

  private enum MovieDetailsPreviewFixtures {
    static let backdropHeight: UInt32 = 1_080
    static let backdropWidth: UInt32 = 1_920
    static let castCount = 10
    static let longSynopsisRepetitions = 40
    static let posterHeight: UInt32 = 1_500
    static let posterWidth: UInt32 = 1_000
    static let releaseYear: UInt32 = 2_026
    static let runtimeSeconds: Int64 = 7_200

    static let selection = MovieDetailsSelection(
      identity: MediaIdentity("movie-preview"),
      title: "The Canonical Movie"
    )

    static func noAction() {
      // Preview controls intentionally have no side effects.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

    static func details(
      title: String = selection.title,
      playability: MediaPlayability = .playable,
      includesArtwork: Bool = true,
      synopsis: String? = "A calm provider-neutral synopsis for the selected canonical Movie."
    ) -> MovieDetails {
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
      return MovieDetails(
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
        playability: playability,
        defaultSource: source
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

    private static var credits: [MovieCredit] {
      let cast = (0..<castCount).map { index in
        MovieCredit(
          name: "Cast Member \(index + 1)",
          role: .actor,
          characterName: "Character \(index + 1)",
        )
      }
      return [
        MovieCredit(
          name: "Ada Director",
          role: .director,
          characterName: nil,
        ),
        MovieCredit(
          name: "Wes Writer",
          role: .writer,
          characterName: nil,
        ),
      ] + cast
    }
  }

  @MainActor
  private func movieDetailsPreview(_ state: MovieDetailsState) -> some View {
    NavigationStack {
      MovieDetailsPresentationView(
        state: state,
        retry: MovieDetailsPreviewFixtures.noAction,
        refresh: MovieDetailsPreviewFixtures.noAction,
        play: MovieDetailsPreviewFixtures.noAction,
        reauthorize: MovieDetailsPreviewFixtures.noAsyncAction,
        artwork: .empty
      )
    }
  }

  #Preview("Movie Details — Loading") {
    movieDetailsPreview(.loading(MovieDetailsPreviewFixtures.selection))
  }

  #Preview("Movie Details — Content") {
    movieDetailsPreview(.content(MovieDetailsPreviewFixtures.details()))
  }

  #Preview("Movie Details — Long synopsis") {
    movieDetailsPreview(
      .content(
        MovieDetailsPreviewFixtures.details(
          synopsis: MovieDetailsPreviewFixtures.longSynopsis
        )
      )
    )
  }

  #Preview("Movie Details — Missing artwork") {
    movieDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(includesArtwork: false))
    )
  }

  #Preview("Movie Details — Temporarily unavailable") {
    movieDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(playability: .temporarilyUnavailable))
    )
  }

  #Preview("Movie Details — No playable source") {
    movieDetailsPreview(
      .content(MovieDetailsPreviewFixtures.details(playability: .noAvailableSource))
    )
  }

  #Preview("Movie Details — Not found") {
    movieDetailsPreview(
      .failed(MovieDetailsPreviewFixtures.selection, .notFound)
    )
  }
#endif
