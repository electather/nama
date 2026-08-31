import Foundation
import Testing

@testable import Nama

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

@Suite("Show, Season, and Episode Details feature")
@MainActor
struct MediaHierarchyFeatureTests {
  @Test("selecting a Show loads canonical Details and its first Season page")
  func showSelectionLoadsDetailsAndSeasons() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("show-selected", kind: .show, title: "Selected Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyDetails(
      selection,
      kindDetails: .show(
        firstReleaseDate: nil,
        lastReleaseDate: nil,
        seasonCount: 2,
        episodeCount: nil
      )
    )
    let seasons = [
      hierarchyChild("season-display-b", kind: .season, title: "Season Two"),
      hierarchyChild("season-display-a", kind: .season, title: "Season One"),
    ]
    let receivedSeasons = [
      seasons[0],
      hierarchyChild("season-display-b", kind: .season, title: "Duplicate Season"),
      seasons[1],
    ]

    feature.select(selection, authorization: authorization)

    #expect(feature.state == .loading(selection))
    #expect(feature.childrenState == .loading)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: receivedSeasons, nextPageToken: "page-two"))
    )

    await eventually {
      feature.state == .content(details)
        && feature.childrenState == .content(items: seasons, nextPageToken: "page-two")
    }
  }

  @Test("a failed later page retries without discarding or reordering confirmed Seasons")
  func laterPageFailureRetriesConfirmedChildren() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("show-pages", kind: .show, title: "Paged Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyDetails(
      selection,
      kindDetails: .show(
        firstReleaseDate: nil,
        lastReleaseDate: nil,
        seasonCount: nil,
        episodeCount: nil
      )
    )
    let first = hierarchyChild("season-first", kind: .season, title: "Season One")
    let duplicate = hierarchyChild("season-first", kind: .season, title: "Duplicate")
    let second = hierarchyChild("season-second", kind: .season, title: "Season Two")

    feature.select(selection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [first], nextPageToken: "next-page"))
    )
    await eventually { feature.state == .content(details) }

    feature.loadMoreChildren()
    #expect(feature.childrenState == .loadingMore(items: [first], pageToken: "next-page"))
    await eventually { await loader.childrenCallCount == 2 }
    await loader.resolveChildren(call: 1, with: .failure(MediaDetailsFailure.transportUnavailable))
    await eventually {
      feature.childrenState
        == .pageFailed(
          items: [first],
          pageToken: "next-page",
          failure: .transportUnavailable
        )
    }

    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 3 }
    #expect(await loader.childrenPageToken(call: 2) == "next-page")
    await resolveDuplicateContinuation(
      loader: loader,
      feature: feature,
      confirmed: [first],
      duplicate: duplicate,
      replacement: second
    )
  }

  @Test("a newer selection cancels and rejects an obsolete child page")
  func newerSelectionRejectsStaleChildPage() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let authorization = try movieDetailsAuthorization(generation: 1)
    let firstSelection = hierarchySelection("show-first", kind: .show, title: "First Show")
    let secondSelection = hierarchySelection("show-second", kind: .show, title: "Second Show")
    let firstDetails = hierarchyShowDetails(firstSelection)
    let secondDetails = hierarchyShowDetails(secondSelection)
    let firstChild = hierarchyChild("season-first", kind: .season, title: "Season One")
    let staleChild = hierarchyChild("season-stale", kind: .season, title: "Stale Season")
    let secondChild = hierarchyChild("season-second", kind: .season, title: "New Season")

    feature.select(firstSelection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(firstDetails))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [firstChild], nextPageToken: "more"))
    )
    await eventually { feature.state == .content(firstDetails) }
    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 2 }

    feature.select(secondSelection, authorization: authorization)

    await eventually { await loader.childrenCancellationCount == 1 }
    await loader.resolveChildren(
      call: 1,
      with: .success(MediaChildrenPage(items: [staleChild], nextPageToken: nil))
    )
    await eventually { await loader.detailsCallCount == 2 }
    await loader.resolveDetails(call: 1, with: .success(secondDetails))
    await eventually { await loader.childrenCallCount == 3 }
    await loader.resolveChildren(
      call: 2,
      with: .success(MediaChildrenPage(items: [secondChild], nextPageToken: nil))
    )

    await eventually {
      feature.state == .content(secondDetails)
        && feature.childrenState == .content(items: [secondChild], nextPageToken: nil)
    }
  }

  @Test("a playable Episode emits the shared opaque canonical Play intent")
  func playableEpisodeEmitsPlayIntent() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("episode-play", kind: .episode, title: "Episode")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyDetails(
      selection,
      kindDetails: .episode(seasonNumber: 2, episodeNumber: 7, releaseDate: nil),
      playability: .playable,
      runtime: .seconds(1_800)
    )

    feature.select(selection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    #expect(await loader.childrenCallCount == 0)
    #expect(feature.play() == MediaPlayIntent(mediaIdentity: selection.identity))
  }

  @Test("touch and pointer approach advances only near the confirmed end")
  func approachNearEndLoadsNextPage() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("season-near-end", kind: .season, title: "Season")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyDetails(
      selection,
      kindDetails: .season(seasonNumber: 1, episodeCount: nil)
    )
    let episodes = [
      hierarchyChild("episode-one", kind: .episode, title: "One", season: 1, episode: 1),
      hierarchyChild("episode-two", kind: .episode, title: "Two", season: 1, episode: 2),
      hierarchyChild("episode-three", kind: .episode, title: "Three", season: 1, episode: 3),
      hierarchyChild("episode-four", kind: .episode, title: "Four", season: 1, episode: 4),
    ]

    feature.select(selection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: episodes, nextPageToken: "more"))
    )
    await eventually { feature.state == .content(details) }

    feature.childDidAppear(episodes[0].identity)
    await Task.yield()
    #expect(await loader.childrenCallCount == 1)

    feature.childDidAppear(episodes[2].identity)
    await eventually { await loader.childrenCallCount == 2 }
    #expect(await loader.childrenPageToken(call: 1) == "more")
    await loader.resolveChildren(
      call: 1,
      with: .success(MediaChildrenPage(items: [], nextPageToken: nil))
    )
  }

  @Test("an ID-only restored selection reloads canonical kind and hierarchy")
  func restoredSelectionReloadsCanonicalDetails() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let restored = MediaDetailsSelection(restoredIdentity: MediaIdentity("restored-show"))
    let canonical = hierarchySelection("restored-show", kind: .show, title: "Restored Show")
    let details = hierarchyShowDetails(canonical)

    feature.select(restored, authorization: try movieDetailsAuthorization(generation: 2))
    #expect(feature.state == .loading(restored))
    #expect(feature.childrenState == .loading)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [], nextPageToken: nil))
    )

    await eventually {
      feature.state == .content(details)
        && feature.childrenState == .content(items: [], nextPageToken: nil)
    }
  }
}

#if os(macOS)
  @Suite("Mac hierarchy materialization")
  @MainActor
  struct MediaHierarchyMaterializationTests {
    @Test("an unscrolled pointer hierarchy does not approach its final child")
    func unscrolledPointerHierarchyKeepsLaterPagesLazy() async throws {
      let children = (1...40).map { number in
        hierarchyChild(
          "episode-\(number)",
          kind: .episode,
          title: "Episode \(number)",
          season: 1,
          episode: UInt32(number)
        )
      }
      var appearedIdentities: [MediaIdentity] = []
      let controller = NSHostingController(
        rootView: NavigationStack {
          ScrollView {
            MediaDetailsChildrenView(
              parentKind: .season,
              state: .content(items: children, nextPageToken: "more"),
              loadMore: {
                Issue.record("An unscrolled hierarchy must not request another page")
              },
              childDidAppear: { appearedIdentities.append($0) },
              reauthorize: {
                Issue.record("An available hierarchy must not request authorization")
              },
              artwork: .empty
            )
          }
          .frame(width: 640, height: 240)
        }
      )
      let window = NSWindow(contentViewController: controller)
      defer { window.close() }

      window.setContentSize(NSSize(width: 640, height: 240))
      window.orderFrontRegardless()
      controller.view.layoutSubtreeIfNeeded()
      await Task.yield()

      #expect(appearedIdentities.contains(children[0].identity))
      #expect(!appearedIdentities.contains(try #require(children.last).identity))
    }
  }
#endif
