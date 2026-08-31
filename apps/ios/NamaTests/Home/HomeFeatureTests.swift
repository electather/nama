import Foundation
import Testing

@testable import Nama

#if os(macOS)
  import AppKit
  import SwiftUI
#endif

private enum HomeFeatureFixture {
  static let tokenExpiry: TimeInterval = 4_600
}

@Suite("Home feature state")
@MainActor
struct HomeFeatureTests {
  @Test("an authorization identity enters Home with Movies before Shows")
  func authorizationEntersHome() async throws {
    let shows = HomeShelf(
      identity: HomeShelfIdentity("shows"),
      title: "Shows",
      kind: .shows,
      items: [homeItem(identity: "show-1", kind: .show, title: "The Show")]
    )
    let movies = HomeShelf(
      identity: HomeShelfIdentity("movies"),
      title: "Movies",
      kind: .movies,
      items: [
        homeItem(identity: "movie-2", kind: .movie, title: "Second from server"),
        homeItem(identity: "movie-1", kind: .movie, title: "First from server"),
      ]
    )
    let snapshot = HomeSnapshot(movies: movies, shows: shows)
    let loader = ImmediateHomeLoader(result: .success(snapshot))
    let feature = HomeFeature(loader: loader, artworkLoader: IgnoringHomeArtworkLoader())

    feature.activate(try homeAuthorization(generation: 1))
    await eventually { feature.state == .content(snapshot) }

    guard case .content(let content) = feature.state else {
      Issue.record("Home did not publish content")
      return
    }
    #expect(content.shelves.map(\.kind) == [.movies, .shows])
    #expect(content.movies?.items.map(\.title) == ["Second from server", "First from server"])
  }

  @Test("empty, catalog preparation, and safe failure remain distinct")
  func distinctTerminalStates() async throws {
    let authorization = try homeAuthorization(generation: 2)

    let emptyFeature = HomeFeature(
      loader: ImmediateHomeLoader(result: .success(HomeSnapshot(movies: nil, shows: nil))),
      artworkLoader: IgnoringHomeArtworkLoader()
    )
    emptyFeature.activate(authorization)
    await eventually { emptyFeature.state == .empty }

    let preparingFeature = HomeFeature(
      loader: ImmediateHomeLoader(result: .failure(.catalogNotReady(retryAfterSeconds: 9))),
      artworkLoader: IgnoringHomeArtworkLoader()
    )
    preparingFeature.activate(authorization)
    await eventually {
      preparingFeature.state == .catalogNotReady(retryAfterSeconds: 9)
    }

    let failedFeature = HomeFeature(
      loader: ImmediateHomeLoader(result: .failure(.authorizationUnavailable)),
      artworkLoader: IgnoringHomeArtworkLoader()
    )
    failedFeature.activate(authorization)
    await eventually {
      failedFeature.state == .failed(.authorizationUnavailable)
    }
  }

  @Test("refresh keeps confirmed content visible until replacement completes")
  func refreshKeepsContent() async throws {
    let loader = ManualHomeLoader()
    let feature = HomeFeature(loader: loader, artworkLoader: IgnoringHomeArtworkLoader())
    let authorization = try homeAuthorization(generation: 3)
    let first = homeSnapshot(movieTitle: "Before refresh")
    let second = homeSnapshot(movieTitle: "After refresh")

    feature.activate(authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(first))
    await eventually { feature.state == .content(first) }

    feature.refresh()
    await eventually { await loader.callCount == 2 }
    #expect(feature.state == .refreshing(first))

    await loader.resolve(call: 1, with: .success(second))
    await eventually { feature.state == .content(second) }
  }

  @Test("a failed refresh preserves confirmed content with an actionable error")
  func refreshFailureKeepsContent() async throws {
    let loader = ManualHomeLoader()
    let feature = HomeFeature(loader: loader, artworkLoader: IgnoringHomeArtworkLoader())
    let authorization = try homeAuthorization(generation: 4)
    let confirmed = homeSnapshot(movieTitle: "Confirmed title")

    feature.activate(authorization)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(confirmed))
    await eventually { feature.state == .content(confirmed) }

    feature.refresh()
    await eventually { await loader.callCount == 2 }
    await loader.resolve(
      call: 1,
      with: .failure(.catalogNotReady(retryAfterSeconds: 9))
    )

    await eventually {
      feature.state
        == .refreshFailed(
          confirmed,
          .catalogNotReady(retryAfterSeconds: 9)
        )
    }
  }

  @Test("changing authorization identity cancels the active Home load")
  func authorizationChangeCancelsLoad() async throws {
    let loader = CancellationHomeLoader()
    let feature = HomeFeature(loader: loader, artworkLoader: IgnoringHomeArtworkLoader())

    feature.activate(try homeAuthorization(generation: 4, endpoint: "https://first.example.test"))
    await eventually { await loader.callCount == 1 }

    feature.activate(try homeAuthorization(generation: 5, endpoint: "https://second.example.test"))
    await eventually {
      let callCount = await loader.callCount
      let cancellationCount = await loader.cancellationCount
      return callCount == 2 && cancellationCount == 1
    }

    feature.activate(try homeAuthorization(generation: 6, endpoint: "https://second.example.test"))
    await eventually {
      let callCount = await loader.callCount
      let cancellationCount = await loader.cancellationCount
      return callCount == 3 && cancellationCount == 2
    }

    feature.deactivate()
  }

  @Test("a stale completion cannot replace media from the current authorization")
  func staleCompletionIsIgnored() async throws {
    let loader = ManualHomeLoader()
    let feature = HomeFeature(loader: loader, artworkLoader: IgnoringHomeArtworkLoader())
    let firstAuthorization = try homeAuthorization(generation: 6)
    let secondAuthorization = try homeAuthorization(generation: 7)
    let stale = homeSnapshot(movieTitle: "Stale title")
    let current = homeSnapshot(movieTitle: "Current title")

    feature.activate(firstAuthorization)
    await eventually { await loader.callCount == 1 }
    feature.activate(secondAuthorization)
    await eventually { await loader.callCount == 2 }

    await loader.resolve(call: 1, with: .success(current))
    await eventually { feature.state == .content(current) }
    await loader.resolve(call: 0, with: .success(stale))
    await Task.yield()

    #expect(feature.state == .content(current))
  }

  @Test("only authorization for the current endpoint enters Home")
  func authorizationTransitionMatchesEndpoint() throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let status = OAuthAuthorizationStatus(record: record)

    let identity = HomeAuthorizationIdentity(
      currentEndpoint: endpoint,
      authorizationState: .authorized(status),
      generation: 8
    )
    let replacement = HomeAuthorizationIdentity(
      currentEndpoint: try NamaEndpoint("https://replacement.example.test"),
      authorizationState: .authorized(status),
      generation: 8
    )
    let pending = HomeAuthorizationIdentity(
      currentEndpoint: endpoint,
      authorizationState: .requesting(endpoint),
      generation: 8
    )

    #expect(identity?.endpoint == endpoint)
    #expect(identity?.generation == 8)
    #expect(replacement == nil)
    #expect(pending == nil)
  }

  #if os(macOS)
    @Test("a transient Mac Home disappearance keeps its initial load alive")
    func transientMacHomeDisappearanceKeepsLoad() async throws {
      let loader = ManualHomeLoader()
      let feature = HomeFeature(
        loader: loader,
        artworkLoader: IgnoringHomeArtworkLoader()
      )
      let controller = NSHostingController(
        rootView: HomeView(
          feature: feature,
          authorization: try homeAuthorization(generation: 9),
          changeEndpoint: {
            Issue.record("A loading Home must not request an endpoint change")
          },
          reauthorize: {
            Issue.record("A loading Home must not request authorization")
          },
          selectMedia: { _ in
            Issue.record("A loading Home must not select media")
          },
          seeAll: { _ in
            Issue.record("A loading Home must not open a Library shelf")
          }
        )
        .environment(\.scenePhase, .active)
      )
      let window = NSWindow(contentViewController: controller)
      defer { window.close() }

      window.orderFrontRegardless()
      controller.view.layoutSubtreeIfNeeded()
      await eventually { await loader.callCount == 1 }

      window.contentViewController = NSHostingController(rootView: EmptyView())
      await Task.yield()
      let snapshot = homeSnapshot(movieTitle: "Completed after disappearance")
      await loader.resolve(call: 0, with: .success(snapshot))

      await eventually { feature.state == .content(snapshot) }
    }
  #endif
}

private actor ImmediateHomeLoader: HomeLoading {
  private let result: Result<HomeSnapshot, HomeLoadingFailure>

  init(result: Result<HomeSnapshot, HomeLoadingFailure>) {
    self.result = result
  }

  func load(for _: HomeAuthorizationIdentity) throws -> HomeSnapshot {
    try result.get()
  }
}

private actor ManualHomeLoader: HomeLoading {
  private var continuations: [CheckedContinuation<HomeSnapshot, any Error>] = []

  var callCount: Int {
    continuations.count
  }

  func load(for _: HomeAuthorizationIdentity) async throws -> HomeSnapshot {
    try await withCheckedThrowingContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resolve(call index: Int, with result: Result<HomeSnapshot, HomeLoadingFailure>) {
    continuations[index].resume(with: result.mapError { $0 as any Error })
  }
}

private actor CancellationHomeLoader: HomeLoading {
  private(set) var callCount = 0
  private(set) var cancellationCount = 0

  func load(for _: HomeAuthorizationIdentity) async throws -> HomeSnapshot {
    callCount += 1
    let stream = AsyncStream<Void> { continuation in
      continuation.onTermination = { [weak self] _ in
        Task {
          await self?.recordCancellation()
        }
      }
    }
    var iterator = stream.makeAsyncIterator()
    _ = await iterator.next()
    throw CancellationError()
  }

  private func recordCancellation() {
    cancellationCount += 1
  }
}

private actor IgnoringHomeArtworkLoader: HomeArtworkLoading {
  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This adapter has no cache to invalidate.
  }

  func image(
    for _: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    nil
  }
}

private func homeAuthorization(
  generation: UInt64,
  endpoint: String = "https://nama.example.test"
) throws -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: try NamaEndpoint(endpoint),
    accessTokenExpiresAt: Date(timeIntervalSince1970: HomeFeatureFixture.tokenExpiry),
    generation: generation
  )
}

private func homeSnapshot(movieTitle: String) -> HomeSnapshot {
  HomeSnapshot(
    movies: HomeShelf(
      identity: HomeShelfIdentity("movies"),
      title: "Movies",
      kind: .movies,
      items: [homeItem(identity: movieTitle, kind: .movie, title: movieTitle)]
    ),
    shows: nil
  )
}

private func homeItem(
  identity: String,
  kind: MediaKind,
  title: String
) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity(identity),
    kind: kind,
    title: title,
    releaseYear: nil,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: [],
    playability: .playable,
    defaultSource: nil
  )
}
