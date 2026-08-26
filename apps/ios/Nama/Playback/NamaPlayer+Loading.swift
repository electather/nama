internal import AetherEngine
import Foundation

nonisolated private enum NamaPlayerInitialLoadOutcome: Sendable, Equatable {
  case loaded
  case expired
}

extension NamaPlayer {
  func load(_ request: NamaPlayerRequest) {
    let replacementPosition = clock.state.position
    replaceCurrentLoad()
    guard request.hasAllowedInitialDestinations else {
      self.request = nil
      reset(to: .failed(.sanitized(.playbackUnavailable)))
      return
    }
    guard !request.isExpired(at: Date()) else {
      self.request = nil
      reset(to: .idle)
      onLocatorExpired(replacementPosition)
      return
    }
    self.request = request
    let generation = beginEngineObservations()
    reset(to: .loading)
    let resumePosition = request.resumePosition.flatMap(NamaPlayerClockState.nonnegativeFinite)
    loadTask = Task { @MainActor [weak self] in
      await self?.performLoad(request, resumePosition: resumePosition, generation: generation)
    }
  }

  private func replaceCurrentLoad() {
    loadTask?.cancel()
    loadTask = nil
    httpBridge?.stop()
    httpBridge = nil
    invalidateEngineObservations()
    if request != nil {
      engine.stop()
    }
  }

  private func performLoad(
    _ request: NamaPlayerRequest,
    resumePosition: TimeInterval?,
    generation: UInt64
  ) async {
    var ownedBridge: NamaPlaybackHTTPBridge?
    do {
      let bridge = try await NamaPlaybackHTTPBridge.start()
      ownedBridge = bridge
      try Task.checkCancellation()
      guard isCurrentLoad(generation) else {
        throw CancellationError()
      }
      let bridgedRequest = try bridge.prepare(request)
      let externalSubtitles = bridgedRequest.externalSubtitles.map { subtitle in
        Self.externalSubtitle(subtitle, url: subtitle.locator.url)
      }
      try Task.checkCancellation()
      guard isCurrentLoad(generation) else {
        throw CancellationError()
      }
      httpBridge = bridge
      let outcome = try await loadUntilReadyOrExpired(
        request,
        mediaURL: bridgedRequest.media.url,
        externalSubtitles: externalSubtitles,
        resumePosition: resumePosition,
        generation: generation
      )
      guard outcome == .loaded else {
        return
      }
      try await Self.waitUntilExpiration(request.earliestExpiration)
      try Task.checkCancellation()
      guard isCurrentLoad(generation) else {
        throw CancellationError()
      }
      expire(bridge, generation: generation)
    } catch is CancellationError {
      discard(ownedBridge)
    } catch {
      discard(ownedBridge)
      guard !Task.isCancelled, isCurrentLoad(generation) else {
        return
      }
      self.request = nil
      invalidateEngineObservations()
      reset(to: .failed(Self.sanitizedFailure(error)))
    }
  }

  private func loadUntilReadyOrExpired(
    _ request: NamaPlayerRequest,
    mediaURL: URL,
    externalSubtitles: [ExternalSubtitleTrack],
    resumePosition: TimeInterval?,
    generation: UInt64
  ) async throws -> NamaPlayerInitialLoadOutcome {
    guard let bridge = httpBridge else {
      throw CancellationError()
    }
    return try await withThrowingTaskGroup(of: NamaPlayerInitialLoadOutcome.self) { group in
      group.addTask { [weak self] in
        guard let self else {
          throw CancellationError()
        }
        return try await loadEngine(
          request,
          mediaURL: mediaURL,
          externalSubtitles: externalSubtitles,
          resumePosition: resumePosition,
          generation: generation
        )
      }
      group.addTask { [weak self] in
        try await Self.waitUntilExpiration(request.earliestExpiration)
        try Task.checkCancellation()
        guard let self else {
          throw CancellationError()
        }
        await expire(bridge, generation: generation)
        return .expired
      }
      guard let outcome = try await group.next() else {
        throw CancellationError()
      }
      group.cancelAll()
      return outcome
    }
  }

  private func loadEngine(
    _ request: NamaPlayerRequest,
    mediaURL: URL,
    externalSubtitles: [ExternalSubtitleTrack],
    resumePosition: TimeInterval?,
    generation: UInt64
  ) async throws -> NamaPlayerInitialLoadOutcome {
    let probe = try await engine.load(
      url: mediaURL,
      startPosition: resumePosition,
      options: LoadOptions(
        httpHeaders: [:],
        externalSubtitles: externalSubtitles
      )
    )
    try Task.checkCancellation()
    guard isCurrentLoad(generation) else {
      throw CancellationError()
    }
    publishLoadedRequest(probe: probe, mimeType: request.media.mimeType)
    return .loaded
  }

  nonisolated private static func waitUntilExpiration(_ expiration: Date) async throws {
    while true {
      let remaining = expiration.timeIntervalSinceNow
      guard remaining > 0 else {
        return
      }
      try await Task.sleep(for: .seconds(remaining))
    }
  }

  private func expire(_ bridge: NamaPlaybackHTTPBridge, generation: UInt64) {
    guard isCurrentLoad(generation) else {
      return
    }
    let resumePosition = clock.state.position
    bridge.stop()
    if httpBridge === bridge {
      httpBridge = nil
    }
    request = nil
    invalidateEngineObservations()
    engine.stop()
    reset(to: .idle)
    onLocatorExpired(resumePosition)
  }

  private func publishLoadedRequest(probe: SourceProbe?, mimeType: String?) {
    publishVideoCharacteristics(from: probe, mimeType: mimeType)
    if probe == nil {
      publishNativeVideoCharacteristics()
    }
    publishTracks()
    publishClock()
  }

  private func discard(_ bridge: NamaPlaybackHTTPBridge?) {
    bridge?.stop()
    if let bridge, httpBridge === bridge {
      httpBridge = nil
    }
  }
}
