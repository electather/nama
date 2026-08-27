import Testing

@testable import Nama

private enum LibraryRecoveryFixture {
  static let generation: UInt64 = 6
  static let expiredContinuationRequestCount = 2
  static let restartedFirstPageRequestCount = 3
}

private struct ExpiredContinuationFixture {
  let loader: ManualLibraryPageLoader
  let feature: LibraryFeature
  let confirmed: [MediaSummary]
}

@Suite("Library page recovery")
@MainActor
struct LibraryPageRecoveryFeatureTests {
  @Test("an expired continuation restarts bounded paging without discarding confirmed items")
  func expiredContinuationRecovery() async throws {
    let fixture = try await expiredContinuationFixture()
    let loader = fixture.loader
    let feature = fixture.feature
    let confirmed = fixture.confirmed

    feature.loadMore()
    await eventually { await loader.calls.count == 2 }
    await loader.resolve(call: 1, with: .failure(.pageTokenInvalid))
    await eventually {
      feature.state
        == .pageFailed(
          LibrarySnapshot(query: .initial, items: confirmed, nextPageToken: "expired"),
          .pageTokenInvalid
        )
    }

    feature.retryPage()
    await eventually { await loader.calls.count == 3 }
    #expect(await loader.calls.last?.pageToken == nil)
    await loader.resolve(
      call: 2,
      with: .success(LibraryPage(items: confirmed, nextPageToken: "replacement"))
    )
    await eventually { await loader.calls.count == 4 }
    #expect(await loader.calls.last?.pageToken == "replacement")
    await loader.resolve(
      call: 3,
      with: .success(
        LibraryPage(
          items: [libraryItem("three", kind: .movie, title: "Three")],
          nextPageToken: nil
        )
      )
    )
    await eventually {
      guard case .content(let snapshot) = feature.state else {
        return false
      }
      return snapshot.items.map(\.title) == ["One", "Two", "Three"]
        && snapshot.isTerminal
    }
  }

  @Test(
    "expired continuation recovery keeps visible items then replaces them in fresh server order")
  func expiredContinuationRecoveryReplacesStalePrefix() async throws {
    let fixture = try await expiredContinuationFixture()
    let loader = fixture.loader

    await restartAfterExpiredContinuation(fixture)
    expectVisibleConfirmedSnapshot(
      fixture,
      message: "Recovery discarded the confirmed snapshot while restarting"
    )

    await loader.resolve(
      call: 2,
      with: .success(
        LibraryPage(
          items: [libraryItem("two", kind: .movie, title: "Two")],
          nextPageToken: "fresh-next"
        )
      )
    )
    await eventually { await loader.calls.count == 4 }
    #expect(await loader.calls.last?.pageToken == "fresh-next")
    expectVisibleConfirmedSnapshot(
      fixture,
      message: "Recovery stopped showing the confirmed snapshot during catch-up"
    )

    await loader.resolve(
      call: 3,
      with: .success(
        LibraryPage(
          items: [
            libraryItem("one", kind: .movie, title: "One"),
            libraryItem("three", kind: .movie, title: "Three"),
          ],
          nextPageToken: nil
        )
      )
    )
    await eventually {
      guard case .content(let snapshot) = fixture.feature.state else {
        return false
      }
      return snapshot.items.map(\.identity)
        == [MediaIdentity("two"), MediaIdentity("one"), MediaIdentity("three")]
        && snapshot.items.map(\.title) == ["Two", "One", "Three"]
        && snapshot.isTerminal
    }
  }

  @Test("an expired recovery continuation failure restarts from the fresh first page")
  func expiredRecoveryContinuationFailureRestartsFromFirstPage() async throws {
    let fixture = try await expiredContinuationFixture()
    let loader = fixture.loader
    let feature = fixture.feature

    feature.loadMore()
    await eventually { await loader.calls.count == 2 }
    await loader.resolve(call: 1, with: .failure(.pageTokenInvalid))
    await eventually {
      if case .pageFailed = feature.state {
        return true
      }
      return false
    }

    feature.retryPage()
    await eventually { await loader.calls.count == 3 }
    #expect(await loader.calls.last?.pageToken == nil)
    await loader.resolve(
      call: 2,
      with: .success(
        LibraryPage(
          items: [libraryItem("two", kind: .movie, title: "Two")],
          nextPageToken: "fresh-next"
        )
      )
    )
    await eventually { await loader.calls.count == 4 }
    #expect(await loader.calls.last?.pageToken == "fresh-next")
    await loader.resolve(call: 3, with: .failure(.pageTokenInvalid))
    await eventually {
      feature.state
        == .pageFailed(
          LibrarySnapshot(
            query: .initial,
            items: fixture.confirmed,
            nextPageToken: "expired"
          ),
          .pageTokenInvalid
        )
    }

    feature.retryPage()
    await eventually { await loader.calls.count == 5 }
    #expect(await loader.calls.last?.pageToken == nil)
  }

  @Test("a failed expired-page recovery remains a later-page failure")
  func expiredRecoveryFailurePreservesPageState() async throws {
    let fixture = try await expiredContinuationFixture()
    fixture.feature.loadMore()
    await eventually { await fixture.loader.calls.count == 2 }
    await fixture.loader.resolve(call: 1, with: .failure(.pageTokenInvalid))
    await eventually {
      if case .pageFailed = fixture.feature.state {
        return true
      }
      return false
    }

    fixture.feature.retryPage()
    await eventually { await fixture.loader.calls.count == 3 }
    await fixture.loader.resolve(call: 2, with: .failure(.networkUnavailable))

    await eventually {
      fixture.feature.state
        == .pageFailed(
          LibrarySnapshot(
            query: .initial,
            items: fixture.confirmed,
            nextPageToken: "expired"
          ),
          .networkUnavailable
        )
    }
  }
}

@MainActor
private func expiredContinuationFixture() async throws -> ExpiredContinuationFixture {
  let loader = ManualLibraryPageLoader()
  let feature = LibraryFeature(
    loader: loader,
    artworkLoader: IgnoringLibraryArtworkLoader()
  )
  feature.activate(try libraryAuthorization(generation: LibraryRecoveryFixture.generation))
  await eventually { await loader.calls.count == 1 }
  let confirmed = [
    libraryItem("one", kind: .movie, title: "One"),
    libraryItem("two", kind: .movie, title: "Two"),
  ]
  await loader.resolve(
    call: 0,
    with: .success(LibraryPage(items: confirmed, nextPageToken: "expired"))
  )
  await eventually {
    if case .content = feature.state {
      return true
    }
    return false
  }
  return ExpiredContinuationFixture(
    loader: loader,
    feature: feature,
    confirmed: confirmed
  )
}

@MainActor
private func restartAfterExpiredContinuation(_ fixture: ExpiredContinuationFixture) async {
  let loader = fixture.loader
  fixture.feature.loadMore()
  await eventually {
    await loader.calls.count == LibraryRecoveryFixture.expiredContinuationRequestCount
  }
  await loader.resolve(call: 1, with: .failure(.pageTokenInvalid))
  await eventually {
    if case .pageFailed = fixture.feature.state {
      return true
    }
    return false
  }

  fixture.feature.retryPage()
  await eventually {
    await loader.calls.count == LibraryRecoveryFixture.restartedFirstPageRequestCount
  }
  #expect(await loader.calls.last?.pageToken == nil)
}

@MainActor
private func expectVisibleConfirmedSnapshot(
  _ fixture: ExpiredContinuationFixture,
  message: String
) {
  guard case .loadingMore(let visible) = fixture.feature.state else {
    Issue.record("\(message)")
    return
  }
  #expect(
    visible
      == LibrarySnapshot(
        query: .initial,
        items: fixture.confirmed,
        nextPageToken: "expired"
      )
  )
}
