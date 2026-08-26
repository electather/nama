#if DEBUG
  import SwiftUI

  private enum HomePreviewFixtures {
    static let longTitle = HomeSnapshot(
      movies: HomeShelf(
        identity: HomeShelfIdentity("movies"),
        title: "Movies",
        kind: .movies,
        items: [
          item(
            identity: "movie-long",
            kind: .movie,
            title: "The Incredibly Long Movie Title That Still Needs a Calm, Readable Home"
          ),
          item(identity: "movie-unavailable", kind: .movie, title: "Quiet Horizon", playable: false),
        ]
      ),
      shows: HomeShelf(
        identity: HomeShelfIdentity("shows"),
        title: "Shows",
        kind: .shows,
        items: [
          item(identity: "show-one", kind: .show, title: "Northern Lights"),
          item(identity: "show-two", kind: .show, title: "Small Hours"),
        ]
      )
    )

    private static func item(
      identity: String,
      kind: HomeMediaKind,
      title: String,
      playable: Bool = true
    ) -> HomeMediaSummary {
      HomeMediaSummary(
        identity: HomeMediaIdentity(identity),
        kind: kind,
        title: title,
        releaseYear: 2026,
        runtime: kind == .movie ? .seconds(7_200) : nil,
        contentRating: nil,
        primaryGenre: "Drama",
        artwork: [
          HomeArtworkReference(
            identity: HomeArtworkIdentity("artwork-\(identity)"),
            role: .poster,
            width: 1_000,
            height: 1_500,
            locale: nil,
            textPresence: .unknown
          )
        ],
        playability: playable ? .playable : .temporarilyUnavailable,
        defaultSource: playable
          ? HomeSourceSummary(
            identity: HomeSourceIdentity("source-\(identity)"),
            label: "4K HDR",
            isDefault: true,
            availability: .available,
            container: "mkv",
            videoQuality: HomeVideoQuality(
              codec: "hevc",
              width: 3_840,
              height: 2_160,
              dynamicRange: .hdr10
            ),
            audioQuality: nil
          )
          : nil
      )
    }
  }

  #Preview("Home — Loading") {
    HomePresentationView(
      state: .loading,
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Empty") {
    HomePresentationView(
      state: .empty,
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Long title and content") {
    HomePresentationView(
      state: .content(HomePreviewFixtures.longTitle),
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Refreshing") {
    HomePresentationView(
      state: .refreshing(HomePreviewFixtures.longTitle),
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Refresh failed") {
    HomePresentationView(
      state: .refreshFailed(HomePreviewFixtures.longTitle, .networkUnavailable),
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Catalog preparation") {
    HomePresentationView(
      state: .catalogNotReady(retryAfterSeconds: 9),
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }

  #Preview("Home — Failure") {
    HomePresentationView(
      state: .failed(.namaUnavailable(requestID: "request-safe-123")),
      retry: {},
      refresh: {},
      changeEndpoint: {},
      reauthorize: {}
    )
  }
#endif
