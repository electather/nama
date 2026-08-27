import Testing

@testable import Nama

private enum LibraryRecoveryFixture {
  static let generation: UInt64 = 6
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
