import Testing

@testable import Nama

@Suite("Canonical child-page recovery")
@MainActor
struct MediaPageRecoveryFeatureTests {
  @Test("an expired page restarts without discarding confirmed children")
  func expiredPageRestartsFromBeginning() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("show-expired", kind: .show, title: "Expired Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let first = hierarchyChild("season-first", kind: .season, title: "Season One")
    let second = hierarchyChild("season-second", kind: .season, title: "Season Two")

    feature.select(selection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(hierarchyShowDetails(selection)))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [first], nextPageToken: "expired"))
    )
    await eventually { feature.state == .content(hierarchyShowDetails(selection)) }

    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 2 }
    await loader.resolveChildren(call: 1, with: .failure(MediaDetailsFailure.pageTokenInvalid))
    await eventually {
      feature.childrenState
        == .pageFailed(
          items: [first],
          pageToken: "expired",
          failure: .pageTokenInvalid
        )
    }

    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 3 }
    #expect(await loader.childrenPageToken(call: 2) == nil)
    await loader.resolveChildren(
      call: 2,
      with: .success(
        MediaChildrenPage(items: [first], nextPageToken: "fresh-next")
      )
    )
    await eventually { await loader.childrenCallCount == 4 }
    #expect(await loader.childrenPageToken(call: 3) == "fresh-next")
    await loader.resolveChildren(
      call: 3,
      with: .success(
        MediaChildrenPage(items: [second], nextPageToken: nil)
      )
    )

    await eventually {
      feature.childrenState
        == .content(items: [first, second], nextPageToken: nil)
    }
  }
  @Test("a refreshed hierarchy cancels a page started during refresh")
  func refreshCancelsConcurrentChildPage() async throws {
    let loader = ManualHierarchyDetailsLoader()
    let feature = MediaDetailsFeature(
      loader: loader,
      artworkLoader: MissingMovieDetailsArtworkLoader()
    )
    let selection = hierarchySelection("show-refresh-page", kind: .show, title: "Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyShowDetails(selection)
    let first = hierarchyChild("season-first", kind: .season, title: "Season One")
    let refreshed = hierarchyChild("season-refreshed", kind: .season, title: "Season Two")

    feature.select(selection, authorization: authorization)
    await eventually { await loader.detailsCallCount == 1 }
    await loader.resolveDetails(call: 0, with: .success(details))
    await eventually { await loader.childrenCallCount == 1 }
    await loader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [first], nextPageToken: "old-next"))
    )
    await eventually { feature.state == .content(details) }

    feature.refresh()
    await eventually { await loader.detailsCallCount == 2 }
    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 2 }
    await loader.resolveDetails(call: 1, with: .success(details))
    await eventually { await loader.childrenCallCount == 3 }
    await loader.resolveChildren(
      call: 2,
      with: .success(MediaChildrenPage(items: [refreshed], nextPageToken: "fresh-next"))
    )
    await eventually { await loader.childrenCancellationCount == 1 }
    await loader.resolveChildren(
      call: 1,
      with: .success(MediaChildrenPage(items: [first], nextPageToken: nil))
    )
    await Task.yield()

    #expect(
      feature.childrenState
        == .content(items: [refreshed], nextPageToken: "fresh-next")
    )
    feature.loadMoreChildren()
    await eventually { await loader.childrenCallCount == 4 }
    #expect(await loader.childrenPageToken(call: 3) == "fresh-next")
  }
}
enum DuplicateContinuationCall {
  static let duplicatePage = 2
  static let freshPage = 3
  static let countAfterContinuation = 4
}

@MainActor
func resolveDuplicateContinuation(
  loader: ManualHierarchyDetailsLoader,
  feature: MediaDetailsFeature,
  confirmed: [MediaSummary],
  duplicate: MediaSummary,
  replacement: MediaSummary
) async {
  await loader.resolveChildren(
    call: DuplicateContinuationCall.duplicatePage,
    with: .success(MediaChildrenPage(items: [duplicate], nextPageToken: "fresh-next"))
  )
  await eventually {
    await loader.childrenCallCount == DuplicateContinuationCall.countAfterContinuation
  }
  #expect(
    await loader.childrenPageToken(call: DuplicateContinuationCall.freshPage) == "fresh-next"
  )
  await loader.resolveChildren(
    call: DuplicateContinuationCall.freshPage,
    with: .success(MediaChildrenPage(items: [replacement], nextPageToken: nil))
  )
  await eventually {
    feature.childrenState == .content(items: confirmed + [replacement], nextPageToken: nil)
  }
}
