import AetherEngine
import Combine
import Foundation
import Observation

@MainActor
@Observable
final class NamaPlayer {
  private(set) var state: PlaybackState = .idle
  private(set) var audioTracks: [PlaybackAudioTrack] = []
  private(set) var subtitleTracks: [PlaybackSubtitleTrack] = []
  private(set) var activeAudioTrackID: String?
  private(set) var activeSubtitleTrackID: String?
  private(set) var subtitleCues: [PlaybackSubtitleCue] = []
  private(set) var videoDiagnostics: PlaybackVideoDiagnostics?
  private(set) var advisoryRedirectOriginCount = 0
  let clock = NamaPlaybackClock()

  @ObservationIgnored private let engine: AetherEngine
  @ObservationIgnored private var loadTask: Task<Void, Never>?
  @ObservationIgnored private var fence = PlaybackLoadFence()
  @ObservationIgnored private var observations: Set<AnyCancellable> = []
  @ObservationIgnored private var request: PlaybackRequest?

  init() throws {
    engine = try AetherEngine()
    observeEngine()
  }

  func load(_ request: PlaybackRequest) {
    loadTask?.cancel()
    engine.stop(resetDisplayCriteria: false, finalTeardown: false)
    let generation = fence.begin()
    self.request = request
    reset(for: request)

    loadTask = Task { @MainActor [weak self] in
      guard let self else { return }
      defer { clearLoadTask(for: generation) }
      do {
        let probe = try await engine.load(
          url: request.media.url,
          startPosition: request.resumePosition,
          options: LoadOptions(
            httpHeaders: request.media.httpHeaders,
            externalSubtitles: request.externalSubtitles.map(Self.externalSubtitle)
          )
        )
        guard !Task.isCancelled, fence.permitsTerminalPublication(for: generation) else { return }
        publishStableState(probe: probe, mimeType: request.media.mimeType)
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled, fence.permitsTerminalPublication(for: generation) else { return }
        state = .failed(AetherPlaybackMapping.failure(error))
      }
    }
  }

  func retry() {
    guard let request else { return }
    load(request)
  }

  func stop() {
    loadTask?.cancel()
    loadTask = nil
    fence.invalidate()
    request = nil
    engine.stop()
    reset(for: nil)
  }

  func togglePlayPause() {
    switch state {
    case .playing, .seeking: engine.pause()
    case .paused: engine.play()
    case .ended: retry()
    default: break
    }
  }

  func seek(to seconds: TimeInterval) {
    let target = min(max(0, seconds), clock.state.duration)
    clock.state.seekTarget = target
    Task { @MainActor [weak self] in
      guard let self else { return }
      await engine.seek(to: target)
    }
  }

  func selectAudioTrack(id: String) {
    guard let index = Int(id) else { return }
    engine.selectAudioTrack(index: index)
  }

  func selectSubtitleTrack(id: String?) {
    guard let id, let index = Int(id) else {
      engine.clearSubtitle()
      return
    }
    engine.selectSubtitleTrack(index: index)
  }

  private func observeEngine() {
    engine.$state.sink { [weak self] state in
      guard let self, acceptsEngineObservations else { return }
      self.state = AetherPlaybackMapping.state(state)
    }.store(in: &observations)
    engine.$audioTracks.sink { [weak self] tracks in
      guard let self, acceptsEngineObservations else { return }
      self.audioTracks = tracks.map(AetherPlaybackMapping.audioTrack)
    }.store(in: &observations)
    engine.$subtitleTracks.sink { [weak self] tracks in
      guard let self, acceptsEngineObservations else { return }
      self.subtitleTracks = tracks.map(AetherPlaybackMapping.subtitleTrack)
    }.store(in: &observations)
    engine.$activeAudioTrackIndex.sink { [weak self] id in
      guard let self, acceptsEngineObservations else { return }
      self.activeAudioTrackID = id.map { String($0) }
    }.store(in: &observations)
    engine.$activeSubtitleTrackIndex.sink { [weak self] id in
      guard let self, acceptsEngineObservations else { return }
      self.activeSubtitleTrackID = id.map { String($0) }
    }.store(in: &observations)
    engine.$subtitleCues.sink { [weak self] cues in
      guard let self, acceptsEngineObservations else { return }
      self.subtitleCues = cues.map(AetherPlaybackMapping.subtitleCue)
    }.store(in: &observations)
    engine.clock.$currentTime.combineLatest(
      engine.$duration,
      engine.clock.$bufferedPosition,
      engine.$seekTarget
    ).sink { [weak self] values in
      let (currentTime, duration, bufferedPosition, seekTarget) = values
      guard let self, acceptsEngineObservations else { return }
      self.clock.state = PlaybackClockState(
        currentTime: currentTime,
        duration: duration,
        bufferedPosition: bufferedPosition,
        seekTarget: seekTarget
      )
    }.store(in: &observations)
  }

  private func publishStableState(probe: SourceProbe?, mimeType: String?) {
    state = AetherPlaybackMapping.state(engine.state)
    audioTracks = engine.audioTracks.map(AetherPlaybackMapping.audioTrack)
    subtitleTracks = engine.subtitleTracks.map(AetherPlaybackMapping.subtitleTrack)
    activeAudioTrackID = engine.activeAudioTrackIndex.map { String($0) }
    activeSubtitleTrackID = engine.activeSubtitleTrackIndex.map { String($0) }
    subtitleCues = engine.subtitleCues.map(AetherPlaybackMapping.subtitleCue)
    clock.state = PlaybackClockState(
      currentTime: engine.clock.currentTime,
      duration: engine.duration,
      bufferedPosition: engine.clock.bufferedPosition,
      seekTarget: engine.seekTarget
    )
    guard let probe else { return }
    videoDiagnostics = AetherPlaybackMapping.videoDiagnostics(
      probe: probe,
      container: Self.container(from: mimeType),
      outputDynamicRange: engine.videoFormat
    )
  }

  private var acceptsEngineObservations: Bool {
    loadTask == nil && request != nil
  }

  private func clearLoadTask(for generation: UInt64) {
    guard fence.permitsTerminalPublication(for: generation) else { return }
    loadTask = nil
  }

  private func reset(for request: PlaybackRequest?) {
    state = request == nil ? .idle : .loading
    audioTracks = []
    subtitleTracks = []
    activeAudioTrackID = nil
    activeSubtitleTrackID = nil
    subtitleCues = []
    videoDiagnostics = nil
    advisoryRedirectOriginCount = request?.media.allowedRedirectOrigins.count ?? 0
    clock.reset()
  }

  private static func externalSubtitle(
    _ subtitle: PlaybackExternalSubtitleLocator
  ) -> ExternalSubtitleTrack {
    ExternalSubtitleTrack(
      url: subtitle.locator.url,
      name: subtitle.label,
      language: subtitle.language,
      isForced: subtitle.isForced,
      isDefault: subtitle.isDefault,
      httpHeaders: subtitle.locator.httpHeaders,
      formatHint: subtitle.locator.mimeType.flatMap(subtitleExtension)
    )
  }

  private static func subtitleExtension(for mimeType: String) -> String? {
    switch mimeType.lowercased() {
    case "application/x-subrip": "srt"
    case "text/vtt": "vtt"
    case "text/x-ass", "text/x-ssa": "ass"
    default: nil
    }
  }

  private static func container(from mimeType: String?) -> String? {
    guard let mimeType else { return nil }
    return mimeType.split(separator: "/").last.map(String.init)
  }

  var aetherEngine: AetherEngine { engine }
}
