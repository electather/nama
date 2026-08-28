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
