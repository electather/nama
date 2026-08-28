import Testing

@testable import Nama

@Suite("Library refresh")
@MainActor
struct LibraryRefreshFeatureTests {
  @Test("a successful refresh replaces confirmed pages with fresh server order")
  func successfulRefreshReplacesPages() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    feature.activate(try libraryAuthorization(generation: 7))
    await eventually { await loader.calls.count == 1 }
    let confirmed = [
      libraryItem("old-one", kind: .movie, title: "Old One"),
      libraryItem("old-two", kind: .movie, title: "Old Two"),
    ]
    await loader.resolve(
      call: 0,
      with: .success(LibraryPage(items: confirmed, nextPageToken: nil))
    )
    await eventually {
      if case .content = feature.state {
        return true
      }
      return false
    }

    feature.refresh()
    await eventually { await loader.calls.count == 2 }
    let replacement = [
      libraryItem("new-two", kind: .movie, title: "New Two"),
      libraryItem("new-one", kind: .movie, title: "New One"),
    ]
    await loader.resolve(
      call: 1,
      with: .success(LibraryPage(items: replacement, nextPageToken: "fresh-next"))
    )

    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.items.map(\.title) == ["New Two", "New One"]
        && snapshot.nextPageToken == "fresh-next"
    }
  }
}

@Suite("Library Search refresh")
@MainActor
struct LibrarySearchRefreshFeatureTests {
  @Test("a refresh may return the same opaque continuation as the replaced snapshot")
  func refreshAcceptsSameContinuation() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let feature = LibrarySearchFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader(),
      sleep: immediateSearchDelay
    )
    feature.activate(try libraryAuthorization(generation: 8))
    feature.text = "signal"
    await eventually { await loader.calls.count == 1 }
    let item = librarySearchItem("result", kind: .movie, title: "Result")
    let snapshot = LibrarySearchSnapshot(
      query: "signal",
      items: [item],
      nextPageToken: "same-next"
    )
    await loader.resolve(
      call: 0,
      with: .success(LibrarySearchPage(items: [item], nextPageToken: "same-next"))
    )
    await eventually { feature.state == .content(snapshot) }

    feature.refresh()
    await eventually { await loader.calls.count == 2 }
    await loader.resolve(
      call: 1,
      with: .success(LibrarySearchPage(items: [item], nextPageToken: "same-next"))
    )
    await eventually { feature.state != .refreshing(snapshot) }
    #expect(feature.state == .content(snapshot))
  }
}

private func immediateSearchDelay(for _: Duration) async {
  await Task.yield()
}
