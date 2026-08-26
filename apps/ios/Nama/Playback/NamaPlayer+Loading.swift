internal import AetherEngine
import Foundation

@MainActor
enum NamaPlayerLoading {
  struct Result {
    let bridge: NamaPlaybackHTTPBridge
    let probe: SourceProbe?
  }

  static func perform(
    engine: AetherEngine,
    request: NamaPlayerRequest,
    resumePosition: TimeInterval?
  ) async throws -> Result {
    let bridge = try await NamaPlaybackHTTPBridge.start()
    do {
      try Task.checkCancellation()
      let bridgedRequest = try bridge.prepare(request)
      try Task.checkCancellation()
      var engineSubtitles: [ExternalSubtitleTrack] = []
      for subtitle in bridgedRequest.externalSubtitles {
        engineSubtitles.append(NamaPlayer.externalSubtitle(subtitle))
      }
      let probe = try await engine.load(
        url: bridgedRequest.media.url,
        startPosition: resumePosition,
        options: LoadOptions(
          httpHeaders: bridgedRequest.media.headerFields,
          externalSubtitles: engineSubtitles
        )
      )
      try Task.checkCancellation()
      return Result(bridge: bridge, probe: probe)
    } catch {
      bridge.stop()
      throw error
    }
  }
}
