#if DEBUG
  import SwiftUI

  private enum HomePreviewFixtures {
    static let catalogRetrySeconds = 9
    static let movieRuntimeSeconds: Int64 = 7_200
    static let movieRuntime: Duration = .seconds(movieRuntimeSeconds)
    static let posterHeight: UInt32 = 1_500
    static let posterWidth: UInt32 = 1_000
    static let releaseYear: UInt32 = 2_026
    static let videoHeight: UInt32 = 2_160
    static let videoWidth: UInt32 = 3_840

    static func noAction() {
      // Preview controls intentionally have no side effects.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

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
          item(
            identity: "movie-unavailable",
            kind: .movie,
            title: "Quiet Horizon",
            playable: false
          ),
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
        releaseYear: releaseYear,
        runtime: kind == .movie ? movieRuntime : nil,
        contentRating: nil,
        primaryGenre: "Drama",
        artwork: [artwork(identity: identity)],
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
              width: videoWidth,
              height: videoHeight,
              dynamicRange: .hdr10
            ),
            audioQuality: nil
          )
          : nil
      )
    }
    private static func artwork(identity: String) -> HomeArtworkReference {
      HomeArtworkReference(
        identity: HomeArtworkIdentity("artwork-\(identity)"),
        role: .poster,
        width: posterWidth,
        height: posterHeight,
        locale: nil,
        textPresence: .unknown
      )
    }
  }

  #Preview("Home — Loading") {
    HomePresentationView(
      state: .loading,
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Empty") {
    HomePresentationView(
      state: .empty,
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Long title and content") {
    HomePresentationView(
      state: .content(HomePreviewFixtures.longTitle),
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Refreshing") {
    HomePresentationView(
      state: .refreshing(HomePreviewFixtures.longTitle),
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Refresh failed") {
    HomePresentationView(
      state: .refreshFailed(HomePreviewFixtures.longTitle, .networkUnavailable),
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Catalog preparation") {
    HomePresentationView(
      state: .catalogNotReady(retryAfterSeconds: HomePreviewFixtures.catalogRetrySeconds),
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }

  #Preview("Home — Failure") {
    HomePresentationView(
      state: .failed(
        .namaUnavailable(requestID: "2f1c5f44-6a9b-4d2e-8c70-62df607c2efa")
      ),
      retry: HomePreviewFixtures.noAction,
      refresh: HomePreviewFixtures.noAction,
      changeEndpoint: HomePreviewFixtures.noAsyncAction,
      reauthorize: HomePreviewFixtures.noAsyncAction
    )
  }
#endif
