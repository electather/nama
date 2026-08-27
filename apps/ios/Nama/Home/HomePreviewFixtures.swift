#if DEBUG
  import SwiftUI

  private enum HomePreviewFixtures {
    static let catalogRetrySeconds = 9
    static let artworkSymbolSize: CGFloat = 96
    static let artworkHeight: CGFloat = 600
    static let artworkWidth: CGFloat = 400
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

    static func noMediaAction(_: MediaDetailsSelection) {
      // Preview navigation intentionally has no side effects.
    }

    static func noShelfAction(_: HomeShelfKind) {
      // Preview navigation intentionally has no side effects.
    }

    static func noAsyncAction() async {
      await Task.yield()
    }

    static let loadedArtworkIdentity = MediaIdentity("movie-loaded-artwork")
    static let artworkInspection = HomeSnapshot(
      movies: HomeShelf(
        identity: HomeShelfIdentity("movies"),
        title: "Movies",
        kind: .movies,
        items: [
          item(
            identity: loadedArtworkIdentity.rawValue,
            kind: .movie,
            title: "Harbor Lights",
            textPresence: .textless
          ),
          item(
            identity: "movie-fallback",
            kind: .movie,
            title: "Fallback Title",
            textPresence: .containsText
          ),
        ]
      ),
      shows: nil
    )

    @MainActor
    static let loadedArtworkPresentation: HomeArtworkPresentation = {
      let renderer = ImageRenderer(
        content: LinearGradient(
          colors: [.blue, .indigo],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
        .overlay {
          Image(systemName: "sparkles")
            .font(.system(size: artworkSymbolSize))
            .foregroundStyle(.white)
        }
        .frame(width: artworkWidth, height: artworkHeight)
      )
      guard let image = renderer.cgImage else {
        preconditionFailure("Home artwork preview must render")
      }
      return HomeArtworkPresentation(image: image)
    }()

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
      kind: MediaKind,
      title: String,
      playable: Bool = true,
      textPresence: ArtworkTextPresence = .unknown
    ) -> MediaSummary {
      let posterArtwork = ArtworkReference(
        identity: ArtworkIdentity("artwork-\(identity)"),
        role: .poster,
        width: posterWidth,
        height: posterHeight,
        locale: nil,
        textPresence: textPresence
      )
      return MediaSummary(
        identity: MediaIdentity(identity),
        kind: kind,
        title: title,
        releaseYear: releaseYear,
        runtime: kind == .movie ? movieRuntime : nil,
        contentRating: nil,
        primaryGenre: "Drama",
        artwork: [posterArtwork],
        playability: playable ? .playable : .temporarilyUnavailable,
        defaultSource: playable
          ? MediaSourceSummary(
            identity: MediaSourceIdentity("source-\(identity)"),
            label: "4K HDR",
            isDefault: true,
            availability: .available,
            container: "mkv",
            videoQuality: MediaVideoQuality(
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
  }

  @MainActor
  private func homePreview(
    _ state: HomeState,
    artwork: HomeArtworkPresentationAccess = .empty
  ) -> some View {
    NavigationStack {
      HomePresentationView(
        state: state,
        retry: HomePreviewFixtures.noAction,
        refresh: HomePreviewFixtures.noAction,
        changeEndpoint: HomePreviewFixtures.noAsyncAction,
        reauthorize: HomePreviewFixtures.noAsyncAction,
        selectMedia: HomePreviewFixtures.noMediaAction,
        seeAll: HomePreviewFixtures.noShelfAction,
        artwork: artwork
      )
    }
  }

  @MainActor
  func homeArtworkInspectionPreview() -> some View {
    let loadedState = HomeArtworkPresentationState()
    loadedState.replace(with: HomePreviewFixtures.loadedArtworkPresentation)
    return homePreview(
      .content(HomePreviewFixtures.artworkInspection),
      artwork: HomeArtworkPresentationAccess(
        presentationState: { media in
          media == HomePreviewFixtures.loadedArtworkIdentity ? loadedState : nil
        },
        didAppear: { _, _, _ in
          // Static inspection artwork has no loading lifecycle.
        },
        didDisappear: { _, _ in
          // Static inspection artwork has no loading lifecycle.
        }
      )
    )
  }

  #Preview("Home — Loading") {
    homePreview(.loading)
  }

  #Preview("Home — Empty") {
    homePreview(.empty)
  }

  #Preview("Home — Long title and content") {
    homePreview(.content(HomePreviewFixtures.longTitle))
  }

  #Preview("Home — Artwork and fallback") {
    homeArtworkInspectionPreview()
  }

  #Preview("Home — Refreshing") {
    homePreview(.refreshing(HomePreviewFixtures.longTitle))
  }

  #Preview("Home — Refresh failed") {
    homePreview(.refreshFailed(HomePreviewFixtures.longTitle, .networkUnavailable))
  }

  #Preview("Home — Catalog preparation") {
    homePreview(.catalogNotReady(retryAfterSeconds: HomePreviewFixtures.catalogRetrySeconds))
  }

  #Preview("Home — Failure") {
    homePreview(.failed(.namaUnavailable(requestID: "request-safe-123")))
  }
#endif
