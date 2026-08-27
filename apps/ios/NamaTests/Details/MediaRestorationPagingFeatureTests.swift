import Testing

@testable import Nama

@Suite("Restored Details paging")
@MainActor
struct MediaRestorationPagingFeatureTests {
  @Test("an ID-only restored Show accepts later canonical child pages")
  func restoredShowLoadsLaterPage() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let restored = MediaDetailsSelection(restoredIdentity: MediaIdentity("restored-show-pages"))
    let canonical = hierarchySelection(
      "restored-show-pages",
      kind: .show,
      title: "Restored Show"
    )
    let first = hierarchyChild("season-one", kind: .season, title: "Season One")
    let second = hierarchyChild("season-two", kind: .season, title: "Season Two")

    feature.select(restored, authorization: try movieDetailsAuthorization(generation: 3))
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(hierarchyShowDetails(canonical)))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [first], nextPageToken: "next"))
    )
    await eventually {
      feature.childrenState == .content(items: [first], nextPageToken: "next")
    }

    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 2 }
    await loader.resolveChildren(
      call: 1,
      with: .success(MediaChildrenPage(items: [second], nextPageToken: nil))
    )

    await eventually {
      feature.childrenState == .content(items: [first, second], nextPageToken: nil)
    }
  }
}
