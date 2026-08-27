#if DEBUG
  import SwiftUI

  private enum HierarchyDetailsPreviewFixtures {
    static let firstReleaseDay: Int32 = 12
    static let firstReleaseMonth: Int32 = 9
    static let firstReleaseYear: Int32 = 2_024
    static let episodeNumber: UInt32 = 7
    static let runtimeSeconds: Int64 = 2_700
    static let seasonNumber: UInt32 = 2
    static let showSeasonCount: UInt32 = 3

    static let show = details(
      identity: "show-preview",
      title: "A Canonical Show With a Long Title That Wraps Without Losing Its Identity",
      kindDetails: .show(
        firstReleaseDate: MediaCalendarDate(
          year: firstReleaseYear,
          month: firstReleaseMonth,
          day: firstReleaseDay
        ),
        lastReleaseDate: nil,
        seasonCount: showSeasonCount,
        episodeCount: nil
      )
    )
    static let showParent = MediaDetailsParent(
      identity: MediaIdentity("show-preview"),
      kind: .show,
      title: show.title
    )
    static let season = details(
      identity: "season-preview",
      title: "Season Two",
      kindDetails: .season(seasonNumber: seasonNumber, episodeCount: nil),
      parents: [showParent]
    )
    static let episode = episodeDetails(playability: .playable)
    static let unavailableEpisode = episodeDetails(playability: .temporarilyUnavailable)
    static let seasons = [
      child("season-one", kind: .season, title: "Season One"),
      child("season-preview", kind: .season, title: "Season Two"),
      child(
        "season-three",
        kind: .season,
        title: "Season Three With a Deliberately Long Canonical Display Title"
      ),
    ]
    static let episodes = [
      child(
        "episode-six",
        kind: .episode,
        title: "Episode Six",
        episodeNumber: episodeNumber - 1
      ),
      child(
        "episode-preview",
        kind: .episode,
        title: episode.title,
        episodeNumber: episodeNumber,
        runtime: .seconds(runtimeSeconds),
        playability: .playable
      ),
    ]

    static func noAction() {
      // Preview actions intentionally have no side effects.
    }

    static func noMediaAction(_: MediaIdentity) {
      // Preview visibility starts no loading work.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

    private static func episodeDetails(playability: MediaPlayability) -> MediaDetails {
      details(
        identity: "episode-preview",
        title: "The Episode With a Long Canonical Title and No Artwork",
        kindDetails: .episode(
          seasonNumber: seasonNumber,
          episodeNumber: episodeNumber,
          releaseDate: nil
        ),
        parents: [
          MediaDetailsParent(
            identity: MediaIdentity("show-preview"),
            kind: .show,
            title: show.title
          ),
          MediaDetailsParent(
            identity: MediaIdentity("season-preview"),
            kind: .season,
            title: season.title
          ),
        ],
        playability: playability,
        runtime: .seconds(runtimeSeconds)
      )
    }

    private static func details(
      identity: String,
      title: String,
      kindDetails: MediaDetailsKind,
      parents: [MediaDetailsParent] = [],
      playability: MediaPlayability = .noAvailableSource,
      runtime: Duration? = nil
    ) -> MediaDetails {
      MediaDetails(
        identity: MediaIdentity(identity),
        title: title,
        releaseYear: nil,
        runtime: runtime,
        contentRating: nil,
        primaryGenre: "Drama",
        tagline: nil,
        synopsis:
          "Canonical metadata stays readable while hierarchy remains the primary continuation.",
        genres: ["Drama"],
        studios: [],
        credits: [],
        artwork: [],
        parents: parents,
        playability: playability,
        defaultSource: playability == .playable
          ? MediaSourceSummary(
            identity: MediaSourceIdentity("source-preview"),
            label: nil,
            isDefault: true,
            availability: .available,
            container: nil,
            videoQuality: nil,
            audioQuality: nil
          )
          : nil,
        kindDetails: kindDetails
      )
    }

    private static func child(
      _ identity: String,
      kind: MediaKind,
      title: String,
      episodeNumber: UInt32? = nil,
      runtime: Duration? = nil,
      playability: MediaPlayability = .noAvailableSource
    ) -> MediaSummary {
      MediaSummary(
        identity: MediaIdentity(identity),
        kind: kind,
        title: title,
        releaseYear: nil,
        runtime: runtime,
        contentRating: nil,
        primaryGenre: nil,
        artwork: [],
        playability: playability,
        defaultSource: nil,
        episodePosition: episodeNumber.map { episodeNumber in
          MediaEpisodePosition(
            seasonNumber: seasonNumber,
            episodeNumber: episodeNumber
          )
        }
      )
    }
  }

  @MainActor
  private func hierarchyDetailsPreview(
    _ details: MediaDetails,
    childrenState: MediaChildrenState = .notApplicable
  ) -> some View {
    NavigationStack {
      MediaDetailsPresentationView(
        state: .content(details),
        idleTitle: details.title,
        childrenState: childrenState,
        retry: HierarchyDetailsPreviewFixtures.noAction,
        refresh: HierarchyDetailsPreviewFixtures.noAction,
        play: HierarchyDetailsPreviewFixtures.noAction,
        loadMoreChildren: HierarchyDetailsPreviewFixtures.noAction,
        childDidAppear: HierarchyDetailsPreviewFixtures.noMediaAction,
        reauthorize: HierarchyDetailsPreviewFixtures.noAsyncAction,
        artwork: .empty,
        childArtwork: .empty,
        creditArtwork: .empty
      )
    }
  }

  #Preview("Show Details — Seasons") {
    hierarchyDetailsPreview(
      HierarchyDetailsPreviewFixtures.show,
      childrenState: .content(
        items: HierarchyDetailsPreviewFixtures.seasons,
        nextPageToken: "more-seasons"
      )
    )
  }

  #Preview("Show Details — Later-page failure") {
    hierarchyDetailsPreview(
      HierarchyDetailsPreviewFixtures.show,
      childrenState: .pageFailed(
        items: HierarchyDetailsPreviewFixtures.seasons,
        pageToken: "more-seasons",
        failure: .transportUnavailable
      )
    )
  }

  #Preview("Season Details — Episodes") {
    hierarchyDetailsPreview(
      HierarchyDetailsPreviewFixtures.season,
      childrenState: .content(
        items: HierarchyDetailsPreviewFixtures.episodes,
        nextPageToken: nil
      )
    )
  }

  #Preview("Episode Details — Play") {
    hierarchyDetailsPreview(HierarchyDetailsPreviewFixtures.episode)
  }

  #Preview("Episode Details — Temporarily unavailable") {
    hierarchyDetailsPreview(HierarchyDetailsPreviewFixtures.unavailableEpisode)
  }
#endif
