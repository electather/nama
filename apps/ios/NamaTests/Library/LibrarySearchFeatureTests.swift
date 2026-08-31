import Foundation
import Testing

@testable import Nama

@Suite("Library search feature")
@MainActor
struct LibrarySearchFeatureTests {
  @Test("trimmed nonempty text waits 300 milliseconds and preserves ranked all-kind results")
  func debounceWhitespaceAndRankPreservation() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let sleeper = ManualLibrarySearchSleeper()
    let feature = searchFeature(loader: loader, sleeper: sleeper)
    let authorization = try libraryAuthorization(generation: 20)
    feature.activate(authorization)

    feature.text = " \n\t "
    #expect(feature.state == .idle)
    #expect(await loader.calls.isEmpty)
    #expect(await sleeper.requestedDurations.isEmpty)

    await startDebouncedSearch(
      "  north star \n",
      feature: feature,
      sleeper: sleeper,
      loader: loader
    )
    #expect(
      await sleeper.requestedDurations == [LibraryFeatureFixture.searchDebounceDuration]
    )
    let call = try #require(await loader.calls.first)
    #expect(call.query == "north star")
    #expect(call.pageToken == nil)
    #expect(call.authorization == authorization)

    let rankedItems = [
      librarySearchItem(
        "episode",
        kind: .episode,
        title: "Episode",
        releaseYear: 2_025,
        episodePosition: MediaEpisodePosition(seasonNumber: 2, episodeNumber: 4)
      ),
      librarySearchItem("movie", kind: .movie, title: "Movie"),
      librarySearchItem("season", kind: .season, title: "Season"),
      librarySearchItem("show", kind: .show, title: "Show"),
    ]
    await loader.resolve(
      call: 0,
      with: .success(LibrarySearchPage(items: rankedItems, nextPageToken: nil))
    )
    await eventually {
      feature.state
        == .content(
          LibrarySearchSnapshot(
            query: "north star",
            items: rankedItems,
            nextPageToken: nil
          )
        )
    }
  }

  @Test("query replacement cancels obsolete work and rejects stale completion")
  func queryReplacementRejectsStaleCompletion() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let sleeper = ManualLibrarySearchSleeper()
    let feature = searchFeature(loader: loader, sleeper: sleeper)
    feature.activate(try libraryAuthorization(generation: 21))

    await startDebouncedSearch("first", feature: feature, sleeper: sleeper, loader: loader)
    await startDebouncedSearch(
      "second",
      feature: feature,
      sleeper: sleeper,
      loader: loader,
      expectedCallCount: 2
    )
    await eventually { await loader.cancellationCount == 1 }
    await loader.resolve(
      call: 0,
      with: .success(
        LibrarySearchPage(
          items: [librarySearchItem("stale", kind: .movie, title: "Stale")],
          nextPageToken: nil
        )
      )
    )
    await Task.yield()
    #expect(feature.state == .loading)

    let current = librarySearchItem("current", kind: .show, title: "Current")
    await loader.resolve(
      call: 1,
      with: .success(LibrarySearchPage(items: [current], nextPageToken: nil))
    )
    await eventually {
      feature.state
        == .content(
          LibrarySearchSnapshot(query: "second", items: [current], nextPageToken: nil)
        )
    }
  }

  @Test("clearing cancels obsolete work and returns Search to idle")
  func clearingRejectsStaleCompletion() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let sleeper = ManualLibrarySearchSleeper()
    let feature = searchFeature(loader: loader, sleeper: sleeper)
    feature.activate(try libraryAuthorization(generation: 22))
    await startDebouncedSearch("third", feature: feature, sleeper: sleeper, loader: loader)

    feature.text = "   "
    #expect(feature.state == .idle)
    await eventually { await loader.cancellationCount == 1 }
    await loader.resolve(
      call: 0,
      with: .success(
        LibrarySearchPage(
          items: [librarySearchItem("cleared", kind: .season, title: "Cleared")],
          nextPageToken: nil
        )
      )
    )
    await Task.yield()
    #expect(feature.state == .idle)
  }

  @Test("no results preserves query and Clear Search returns to idle")
  func noResultsAndClear() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let feature = immediateSearchFeature(loader: loader)
    feature.activate(try libraryAuthorization(generation: 23))
    feature.text = "missing"
    await eventually { await loader.calls.count == 1 }
    await loader.resolve(
      call: 0,
      with: .success(LibrarySearchPage(items: [], nextPageToken: nil))
    )
    await eventually { feature.state == .noResults(query: "missing") }

    feature.clear()
    #expect(feature.text.isEmpty)
    #expect(feature.state == .idle)
  }

  @Test("catalog preparation preserves server retry guidance")
  func catalogPreparationRetryGuidance() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let feature = immediateSearchFeature(loader: loader)
    feature.activate(try libraryAuthorization(generation: 28))
    feature.text = "preparing"
    await eventually { await loader.calls.count == 1 }

    await loader.resolve(call: 0, with: .failure(.catalogNotReady(retryAfterSeconds: 12)))

    await eventually {
      feature.state == .catalogNotReady(retryAfterSeconds: 12)
    }
    #expect(feature.text == "preparing")
  }

  @Test("all result kinds open Details using only opaque canonical identity")
  func selectionForEveryKind() {
    for (index, kind) in [MediaKind.movie, .show, .season, .episode].enumerated() {
      let item = librarySearchItem("opaque-\(index)", kind: kind, title: "Result \(index)")

      #expect(
        homeDetailsSelection(for: item)
          == MediaDetailsSelection(
            identity: item.identity,
            kind: kind,
            title: item.title
          )
      )
    }
  }
}

@Suite("Library search paging")
@MainActor
struct LibrarySearchPagingFeatureTests {
  @Test("an invalid continuation recovers through bounded confirmed pages")
  func invalidContinuationRecovery() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let feature = immediateSearchFeature(loader: loader)
    feature.activate(try libraryAuthorization(generation: 24))
    let first = librarySearchItem("one", kind: .movie, title: "One")
    await loadInitialSearchPage(
      feature: feature,
      loader: loader,
      query: "signal",
      items: [first],
      nextPageToken: "next"
    )

    feature.loadMore()
    await eventually { await loader.calls.count == 2 }
    #expect(await loader.calls.last?.pageToken == "next")
    await loader.resolve(call: 1, with: .failure(.pageTokenInvalid))
    await eventually {
      feature.state
        == .pageFailed(
          LibrarySearchSnapshot(query: "signal", items: [first], nextPageToken: "next"),
          .pageTokenInvalid
        )
    }

    feature.retryPage()
    await eventually { await loader.calls.count == 3 }
    #expect(await loader.calls.last?.pageToken == nil)
    await loader.resolve(
      call: 2,
      with: .success(LibrarySearchPage(items: [first], nextPageToken: "next"))
    )
    await eventually { await loader.calls.count == 4 }
    #expect(await loader.calls.last?.pageToken == "next")

    let second = librarySearchItem("two", kind: .episode, title: "Two")
    await loader.resolve(
      call: 3,
      with: .success(LibrarySearchPage(items: [second], nextPageToken: nil))
    )
    await eventually {
      feature.state
        == .content(
          LibrarySearchSnapshot(
            query: "signal",
            items: [first, second],
            nextPageToken: nil
          )
        )
    }
  }

  @Test("terminal failure preserves text; retry and refresh retain confirmed results")
  func retryAndRefresh() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let sleeper = ManualLibrarySearchSleeper()
    let feature = searchFeature(loader: loader, sleeper: sleeper)
    feature.activate(try libraryAuthorization(generation: 25))
    await startDebouncedSearch("retry me", feature: feature, sleeper: sleeper, loader: loader)
    await loader.resolve(call: 0, with: .failure(.networkUnavailable))
    await eventually { feature.state == .failed(.networkUnavailable) }
    #expect(feature.text == "retry me")

    feature.retry()
    await eventually { await loader.calls.count == 2 }
    #expect(await sleeper.requestedDurations.count == 1)
    let item = librarySearchItem("retained", kind: .show, title: "Retained")
    let snapshot = LibrarySearchSnapshot(
      query: "retry me",
      items: [item],
      nextPageToken: nil
    )
    await loader.resolve(
      call: 1,
      with: .success(LibrarySearchPage(items: [item], nextPageToken: nil))
    )
    await eventually { feature.state == .content(snapshot) }

    feature.refresh()
    await eventually { await loader.calls.count == 3 }
    #expect(feature.state == .refreshing(snapshot))
    await loader.resolve(
      call: 2,
      with: .failure(.namaUnavailable(requestID: nil))
    )
    await eventually {
      feature.state == .refreshFailed(snapshot, .namaUnavailable(requestID: nil))
    }
    #expect(feature.text == "retry me")
  }

  @Test("authorization replacement cancels and reloads without stale publication")
  func authorizationReplacement() async throws {
    let loader = ManualLibrarySearchPageLoader()
    let sleeper = ManualLibrarySearchSleeper()
    let feature = searchFeature(loader: loader, sleeper: sleeper)
    let firstAuthorization = try libraryAuthorization(generation: 26)
    let secondAuthorization = try libraryAuthorization(generation: 27)
    feature.activate(firstAuthorization)
    await startDebouncedSearch("identity", feature: feature, sleeper: sleeper, loader: loader)

    feature.activate(secondAuthorization)
    await releaseDebounce(sleeper: sleeper, loader: loader, expectedCallCount: 2)
    #expect(await loader.calls.last?.authorization == secondAuthorization)
    await loader.resolve(
      call: 0,
      with: .success(
        LibrarySearchPage(
          items: [librarySearchItem("stale-auth", kind: .movie, title: "Stale")],
          nextPageToken: nil
        )
      )
    )
    await Task.yield()
    #expect(feature.state == .loading)

    let current = librarySearchItem("current-auth", kind: .movie, title: "Current")
    await loader.resolve(
      call: 1,
      with: .success(LibrarySearchPage(items: [current], nextPageToken: nil))
    )
    await eventually {
      feature.state
        == .content(
          LibrarySearchSnapshot(
            query: "identity",
            items: [current],
            nextPageToken: nil
          )
        )
    }
  }
}

@MainActor
private func searchFeature(
  loader: ManualLibrarySearchPageLoader,
  sleeper: ManualLibrarySearchSleeper
) -> LibrarySearchFeature {
  LibrarySearchFeature(
    loader: loader,
    artworkLoader: IgnoringLibraryArtworkLoader(),
    sleep: sleeper.sleep
  )
}

@MainActor
private func immediateSearchFeature(
  loader: ManualLibrarySearchPageLoader
) -> LibrarySearchFeature {
  LibrarySearchFeature(
    loader: loader,
    artworkLoader: IgnoringLibraryArtworkLoader(),
    sleep: immediateLibrarySearchSleep
  )
}

private func immediateLibrarySearchSleep(for _: Duration) async {
  await Task.yield()
}

@MainActor
private func startDebouncedSearch(
  _ text: String,
  feature: LibrarySearchFeature,
  sleeper: ManualLibrarySearchSleeper,
  loader: ManualLibrarySearchPageLoader,
  expectedCallCount: Int = 1
) async {
  feature.text = text
  await eventually {
    await sleeper.requestedDurations.count == expectedCallCount
  }
  #expect(await sleeper.requestedDurations.last == LibraryFeatureFixture.searchDebounceDuration)
  #expect(await loader.calls.count == expectedCallCount - 1)
  #expect(feature.state == .loading)
  await sleeper.releaseNext()
  await eventually { await loader.calls.count == expectedCallCount }
}

@MainActor
private func releaseDebounce(
  sleeper: ManualLibrarySearchSleeper,
  loader: ManualLibrarySearchPageLoader,
  expectedCallCount: Int
) async {
  await eventually {
    await sleeper.requestedDurations.count == expectedCallCount
  }
  #expect(await sleeper.requestedDurations.last == LibraryFeatureFixture.searchDebounceDuration)
  #expect(await loader.calls.count == expectedCallCount - 1)
  await sleeper.releaseNext()
  await eventually { await loader.calls.count == expectedCallCount }
}

@MainActor
private func loadInitialSearchPage(
  feature: LibrarySearchFeature,
  loader: ManualLibrarySearchPageLoader,
  query: String,
  items: [MediaSummary],
  nextPageToken: String?
) async {
  feature.text = query
  await eventually { await loader.calls.count == 1 }
  await loader.resolve(
    call: 0,
    with: .success(LibrarySearchPage(items: items, nextPageToken: nextPageToken))
  )
  await eventually {
    feature.state
      == .content(
        LibrarySearchSnapshot(query: query, items: items, nextPageToken: nextPageToken)
      )
  }
}
