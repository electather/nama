import Foundation
import Testing

@testable import Nama

@Suite("Media Sources feature state")
@MainActor
struct MediaSourcesFeatureTests {
  @Test(
    "Movie and Episode source choices emit the exact opaque source",
    arguments: [MediaKind.movie, .episode]
  )
  func deliberateSelectionEmitsSourceIntent(_ mediaKind: MediaKind) async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let summary = movieSourceSummary(
      identity: "source-choice",
      isDefault: false,
      availability: .available
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("\(mediaKind)-media"),
      mediaKind: mediaKind,
      mediaTitle: "Canonical selection",
      sourceSummaries: [summary]
    )
    let source = mediaSourceFixture(selection: selection, summary: summary)

    feature.select(selection, authorization: authorization)
    #expect(feature.state == .choosing(selection))

    feature.inspect(summary.identity)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(source))
    await eventually { feature.state == .inspected(selection, summary, source) }

    #expect(
      feature.play()
        == MediaPlayIntent(
          mediaIdentity: selection.mediaIdentity,
          sourceIdentity: summary.identity
        )
    )
  }

  @Test("a missing Source preserves the parent choice and retries the same Source")
  func missingSourceRemainsActionable() async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let summary = movieSourceSummary(
      identity: "source-missing",
      isDefault: false,
      availability: .available
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("movie-missing-source"),
      mediaKind: .movie,
      mediaTitle: "Retained parent",
      sourceSummaries: [summary]
    )

    feature.select(selection, authorization: authorization)
    feature.inspect(summary.identity)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .failure(MediaSourceFailure.missing))
    await eventually { feature.state == .failed(selection, summary, .missing) }

    feature.retry()
    await eventually { await loader.callCount == 2 }
    let source = mediaSourceFixture(selection: selection, summary: summary)
    await loader.resolve(call: 1, with: .success(source))
    await eventually { feature.state == .inspected(selection, summary, source) }
  }

  @Test(
    "unavailable Source responses remain inspectable and retryable without Play",
    arguments: [
      MediaSourceAvailability.providerUnavailable,
      .unsupported,
      .unknown,
    ]
  )
  func unavailableSourceRemainsActionable(
    _ availability: MediaSourceAvailability
  ) async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let summary = movieSourceSummary(
      identity: "source-unavailable",
      isDefault: true,
      availability: availability
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("movie-unavailable-source"),
      mediaKind: .movie,
      mediaTitle: "Unavailable source",
      sourceSummaries: [summary]
    )
    let unavailableSource = mediaSourceFixture(
      selection: selection,
      summary: summary,
      availability: availability
    )

    feature.select(selection, authorization: authorization)
    feature.inspect(summary.identity)
    await eventually { await loader.callCount == 1 }
    await loader.resolve(call: 0, with: .success(unavailableSource))
    await eventually {
      feature.state == .inspected(selection, summary, unavailableSource)
    }
    #expect(feature.play() == nil)

    feature.retry()
    await eventually { await loader.callCount == 2 }
  }

  @Test("returning to Sources refreshes the previously inspected exact request")
  func foregroundReturnRefreshesInspectedSource() async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let summary = movieSourceSummary(
      identity: "source-foreground-refresh",
      isDefault: true,
      availability: .available
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("movie-foreground-refresh"),
      mediaKind: .movie,
      mediaTitle: "Foreground refresh",
      sourceSummaries: [summary]
    )
    let source = mediaSourceFixture(selection: selection, summary: summary)
    let request = ManualMediaSourceLoader.Request(
      mediaIdentity: selection.mediaIdentity,
      sourceIdentity: summary.identity,
      authorization: authorization
    )

    feature.select(selection, authorization: authorization)
    feature.inspect(summary.identity)
    await eventually { await loader.callCount == 1 }
    #expect(await loader.request(at: 0) == request)
    await loader.resolve(call: 0, with: .success(source))
    await eventually { feature.state == .inspected(selection, summary, source) }

    feature.select(selection, authorization: authorization)
    await Task.yield()
    #expect(await loader.callCount == 1)

    feature.deactivate(selection)
    feature.select(selection, authorization: authorization)

    await eventually { await loader.callCount == 2 }
    #expect(await loader.request(at: 1) == request)
  }

  @Test("leaving Sources cancels technical loading without discarding the parent choice")
  func deactivationCancelsInspection() async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let summary = movieSourceSummary(
      identity: "source-leaving",
      isDefault: false,
      availability: .available
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("movie-leaving-sources"),
      mediaKind: .movie,
      mediaTitle: "Leaving Sources",
      sourceSummaries: [summary]
    )
    let source = mediaSourceFixture(selection: selection, summary: summary)

    feature.select(selection, authorization: authorization)
    feature.inspect(summary.identity)
    await eventually { await loader.callCount == 1 }

    feature.deactivate(selection)

    await eventually { await loader.cancellationCount == 1 }
    #expect(feature.state == .choosing(selection))
    await loader.resolve(call: 0, with: .success(source))
    await Task.yield()
    #expect(feature.state == .choosing(selection))
  }
  @Test("a newer Source cancels and rejects the stale Source completion")
  func newerSourceRejectsStaleCompletion() async throws {
    let loader = ManualMediaSourceLoader()
    let feature = MediaSourcesFeature(loader: loader)
    let authorization = try movieDetailsAuthorization(generation: 1)
    let firstSummary = movieSourceSummary(
      identity: "source-first",
      isDefault: true,
      availability: .available
    )
    let secondSummary = movieSourceSummary(
      identity: "source-second",
      isDefault: false,
      availability: .available
    )
    let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("episode-source-replacement"),
      mediaKind: .episode,
      mediaTitle: "Source replacement",
      sourceSummaries: [firstSummary, secondSummary]
    )
    let firstSource = mediaSourceFixture(selection: selection, summary: firstSummary)
    let secondSource = mediaSourceFixture(selection: selection, summary: secondSummary)

    feature.select(selection, authorization: authorization)
    feature.inspect(firstSummary.identity)
    await eventually { await loader.callCount == 1 }

    feature.inspect(secondSummary.identity)
    await eventually {
      let callCount = await loader.callCount
      let cancellationCount = await loader.cancellationCount
      return callCount == 2 && cancellationCount == 1
    }

    await loader.resolve(call: 1, with: .success(secondSource))
    await eventually { feature.state == .inspected(selection, secondSummary, secondSource) }
    await loader.resolve(call: 0, with: .success(firstSource))
    await Task.yield()

    #expect(feature.state == .inspected(selection, secondSummary, secondSource))
  }
}

private enum MediaSourcesFeatureFixture {
  static let bitRateBps: UInt64 = 18_000_000
  static let runtimeSeconds: Int64 = 7_200
}

private func mediaSourceFixture(
  selection: MediaSourcesSelection,
  summary: MediaSourceSummary,
  availability: MediaSourceAvailability = .available
) -> MediaSource {
  MediaSource(
    identity: summary.identity,
    mediaIdentity: selection.mediaIdentity,
    label: summary.label,
    availability: availability,
    runtime: .seconds(MediaSourcesFeatureFixture.runtimeSeconds),
    bitRateBps: MediaSourcesFeatureFixture.bitRateBps,
    parts: []
  )
}

private actor ManualMediaSourceLoader: MediaSourceLoading {
  struct Request: Equatable, Sendable {
    let mediaIdentity: MediaIdentity
    let sourceIdentity: MediaSourceIdentity
    let authorization: HomeAuthorizationIdentity
  }

  private struct PendingLoad {
    let request: Request
    let continuation: CheckedContinuation<MediaSource, any Error>
  }

  private var pendingLoads: [PendingLoad] = []
  private var cancelledLoads = 0

  var callCount: Int {
    pendingLoads.count
  }

  var cancellationCount: Int {
    cancelledLoads
  }

  func request(at index: Int) -> Request? {
    pendingLoads.indices.contains(index) ? pendingLoads[index].request : nil
  }

  func loadSource(
    mediaIdentity: MediaIdentity,
    sourceIdentity: MediaSourceIdentity,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaSource {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pendingLoads.append(
          PendingLoad(
            request: Request(
              mediaIdentity: mediaIdentity,
              sourceIdentity: sourceIdentity,
              authorization: authorization
            ),
            continuation: continuation
          )
        )
      }
    } onCancel: {
      Task {
        await self.recordCancellation()
      }
    }
  }

  func resolve(call index: Int, with result: Result<MediaSource, any Error>) {
    pendingLoads[index].continuation.resume(with: result)
  }

  private func recordCancellation() {
    cancelledLoads += 1
  }
}
