import Foundation
import Testing

@testable import Nama

@Suite("Library feature state")
@MainActor
struct LibraryFeatureTests {
  @Test("the first Library visit requests Movies by title and preserves server order")
  func initialMoviesLoad() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    let authorization = try libraryAuthorization(generation: 1)

    feature.activate(authorization)
    await eventually { await loader.calls.count == 1 }

    let call = try #require(await loader.calls.first)
    #expect(call.query == .initial)
    #expect(call.pageToken == nil)

    await loader.resolve(
      call: 0,
      with: .success(
        LibraryPage(
          items: [
            libraryItem("opaque-2", kind: .movie, title: "Second from server"),
            libraryItem("opaque-1", kind: .movie, title: "First from server"),
            libraryItem("opaque-2", kind: .movie, title: "Duplicate"),
          ],
          nextPageToken: "page-two"
        )
      )
    )

    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.items.map(\.title) == ["Second from server", "First from server"]
        && snapshot.nextPageToken == "page-two"
    }
  }

  @Test("kind and sort changes replace obsolete work without publishing stale pages")
  func queryChangesRejectStalePages() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    feature.activate(try libraryAuthorization(generation: 2))
    await eventually { await loader.calls.count == 1 }

    feature.updateKind(.shows)
    feature.updateSort(.releaseDate)
    await eventually { await loader.calls.count == 3 }

    let currentCall = try #require(await loader.calls.last)
    #expect(currentCall.query == LibraryQuery(kind: .shows, sort: .releaseDate))

    await loader.resolve(
      call: 0,
      with: .success(
        LibraryPage(
          items: [libraryItem("stale", kind: .movie, title: "Stale")],
          nextPageToken: nil
        )
      )
    )
    await loader.resolve(
      call: 2,
      with: .success(
        LibraryPage(
          items: [libraryItem("current", kind: .show, title: "Current")],
          nextPageToken: nil
        )
      )
    )

    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.query == LibraryQuery(kind: .shows, sort: .releaseDate)
        && snapshot.items.map(\.title) == ["Current"]
        && snapshot.isTerminal
    }
  }

  @Test("near-end paging appends unique items and reaches terminal content")
  func nearEndPaging() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    feature.activate(try libraryAuthorization(generation: 3))
    await eventually { await loader.calls.count == 1 }
    let firstItems = [
      libraryItem("one", kind: .movie, title: "One"),
      libraryItem("two", kind: .movie, title: "Two"),
      libraryItem("three", kind: .movie, title: "Three"),
    ]
    await loader.resolve(
      call: 0,
      with: .success(LibraryPage(items: firstItems, nextPageToken: "next"))
    )
    await eventually {
      if case .content = feature.state {
        return true
      }
      return false
    }

    feature.itemDidAppear(MediaIdentity("two"))
    await eventually { await loader.calls.count == 2 }
    let pageCall = try #require(await loader.calls.last)
    #expect(pageCall.pageToken == "next")
    guard case .loadingMore(let confirmed) = feature.state else {
      Issue.record("Library did not retain confirmed items while loading another page")
      return
    }
    #expect(confirmed.items.map(\.identity) == firstItems.map(\.identity))

    await loader.resolve(
      call: 1,
      with: .success(
        LibraryPage(
          items: [
            libraryItem("three", kind: .movie, title: "Duplicate"),
            libraryItem("four", kind: .movie, title: "Four"),
          ],
          nextPageToken: nil
        )
      )
    )
    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.items.map(\.title) == ["One", "Two", "Three", "Four"]
        && snapshot.isTerminal
    }
  }

  @Test("a failed later page and its retry retain every confirmed item")
  func laterPageRetryPreservesItems() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    feature.activate(try libraryAuthorization(generation: 4))
    await eventually { await loader.calls.count == 1 }
    let confirmed = [libraryItem("one", kind: .movie, title: "Confirmed")]
    await loader.resolve(
      call: 0,
      with: .success(LibraryPage(items: confirmed, nextPageToken: "next"))
    )
    await eventually {
      if case .content = feature.state {
        return true
      }
      return false
    }

    feature.loadMore()
    await eventually { await loader.calls.count == 2 }
    await loader.resolve(call: 1, with: .failure(.networkUnavailable))
    await eventually {
      feature.state
        == .pageFailed(
          LibrarySnapshot(query: .initial, items: confirmed, nextPageToken: "next"),
          .networkUnavailable
        )
    }

    feature.retryPage()
    await eventually { await loader.calls.count == 3 }
    #expect(await loader.calls.last?.pageToken == "next")
    await loader.resolve(
      call: 2,
      with: .success(
        LibraryPage(
          items: [libraryItem("two", kind: .movie, title: "Retried")],
          nextPageToken: nil
        )
      )
    )
    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.items.map(\.title) == ["Confirmed", "Retried"]
    }
  }

  @Test("refresh failure keeps confirmed pages visible")
  func refreshFailurePreservesPages() async throws {
    let loader = ManualLibraryPageLoader()
    let feature = LibraryFeature(
      loader: loader,
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    feature.activate(try libraryAuthorization(generation: 5))
    await eventually { await loader.calls.count == 1 }
    let confirmed = LibrarySnapshot(
      query: .initial,
      items: [libraryItem("one", kind: .movie, title: "Confirmed")],
      nextPageToken: nil
    )
    await loader.resolve(
      call: 0,
      with: .success(LibraryPage(items: confirmed.items, nextPageToken: nil))
    )
    await eventually { feature.state == .content(confirmed) }

    feature.refresh()
    await eventually { await loader.calls.count == 2 }
    #expect(feature.state == .refreshing(confirmed))
    await loader.resolve(call: 1, with: .failure(.networkUnavailable))
    await eventually {
      feature.state == .refreshFailed(confirmed, .networkUnavailable)
    }
  }

  @Test("preparation, legitimate empty, and terminal content remain distinct")
  func distinctTerminalStates() async throws {
    let authorization = try libraryAuthorization(generation: 6)

    let preparing = LibraryFeature(
      loader: ImmediateLibraryPageLoader(result: .failure(.catalogNotReady(retryAfterSeconds: 7))),
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    preparing.activate(authorization)
    await eventually { preparing.state == .catalogNotReady(retryAfterSeconds: 7) }

    let empty = LibraryFeature(
      loader: ImmediateLibraryPageLoader(
        result: .success(LibraryPage(items: [], nextPageToken: nil))
      ),
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    empty.activate(authorization)
    await eventually { empty.state == .empty }

    let terminal = LibrarySnapshot(
      query: .initial,
      items: [libraryItem("one", kind: .movie, title: "Only item")],
      nextPageToken: nil
    )
    let complete = LibraryFeature(
      loader: ImmediateLibraryPageLoader(
        result: .success(LibraryPage(items: terminal.items, nextPageToken: nil))
      ),
      artworkLoader: IgnoringLibraryArtworkLoader()
    )
    complete.activate(authorization)
    await eventually { complete.state == .content(terminal) }
    #expect(terminal.isTerminal)
  }
}
