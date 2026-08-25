import AVFoundation
// Swift Format and SwiftLint order these mixed-case module names differently.
// swiftlint:disable:next sorted_imports
internal import AetherEngine
import Combine
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
final class NamaPlayer {
  private(set) var state: NamaPlayerState = .idle
  private(set) var audioTracks: [NamaPlaybackAudioTrack] = []
  private(set) var subtitleTracks: [NamaPlaybackSubtitleTrack] = []
  private(set) var subtitleCues: [NamaPlaybackSubtitleCue] = []
  private(set) var selectedAudioTrackID: String?
  private(set) var selectedSubtitleTrackID: String?
  private(set) var videoCharacteristics: NamaPlaybackVideoCharacteristics?
  private(set) var hasFirstFrame = false
  let clock = NamaPlayerClock()

  @ObservationIgnored private let engine: AetherEngine
  @ObservationIgnored private var observations: Set<AnyCancellable> = []
  @ObservationIgnored private var loadTask: Task<Void, Never>?
  @ObservationIgnored private var request: NamaPlayerRequest?
  @ObservationIgnored private var audioTrackIDs = OpaquePlaybackTrackIDs()
  @ObservationIgnored private var subtitleTrackIDs = OpaquePlaybackTrackIDs()

  init() throws {
    do {
      engine = try AetherEngine()
    } catch {
      throw NamaPlayerInitializationError()
    }
    observations = makeAetherObservations(engine) { [weak self] observation in
      self?.receive(observation)
    }
  }

  func load(_ request: NamaPlayerRequest) {
    loadTask?.cancel()
    if self.request != nil {
      engine.stop()
    }
    self.request = request
    reset(to: .loading)
    let mediaHeaders = request.media.headerFields
    let externalSubtitles = request.externalSubtitles.map(Self.externalSubtitle)
    let resumePosition = request.resumePosition.flatMap(NamaPlayerClockState.nonnegativeFinite)

    loadTask = Task { @MainActor [weak self] in
      guard let self else {
        return
      }
      do {
        let probe = try await engine.load(
          url: request.media.url,
          startPosition: resumePosition,
          options: LoadOptions(
            httpHeaders: mediaHeaders,
            externalSubtitles: externalSubtitles
          )
        )
        guard !Task.isCancelled else {
          return
        }
        publishVideoCharacteristics(from: probe, mimeType: request.media.mimeType)
        if probe == nil {
          publishNativeVideoCharacteristics()
        }
        publishTracks()
        publishClock()
      } catch is CancellationError {
        return
      } catch {
        guard !Task.isCancelled else {
          return
        }
        state = .failed(Self.sanitizedFailure(error))
      }
    }
  }

  func play() { engine.play() }

  func pause() {
    engine.pause()
  }

  @discardableResult
  func seek(to requestedPosition: TimeInterval) -> TimeInterval {
    let target = clock.state.clampedSeekTarget(requestedPosition)
    clock.update(
      NamaPlayerClockState(
        position: clock.state.position,
        duration: clock.state.duration,
        bufferedPosition: clock.state.bufferedPosition,
        seekTarget: target
      )
    )
    Task { @MainActor [weak self] in
      await self?.engine.seek(to: target)
    }
    return target
  }

  func selectAudioTrack(id: String) {
    if let engineID = audioTrackIDs.engineID(for: id) {
      engine.selectAudioTrack(index: engineID)
    }
  }

  func selectSubtitleTrack(id: String) {
    if let engineID = subtitleTrackIDs.engineID(for: id) {
      engine.selectSubtitleTrack(index: engineID)
    }
  }

  func disableSubtitles() {
    engine.clearSubtitle()
  }

  func stop() {
    loadTask?.cancel()
    loadTask = nil
    request = nil
    engine.stop()
    reset(to: .idle)
  }

  var surface: some View {
    AetherPlayerSurface(engine: engine)
  }

  private func receive(_ observation: NamaPlayerObservation) {
    switch observation {
    case .state(let state):
      self.state = state

    case .tracks:
      publishTracks()

    case .selectedAudio(let engineID):
      selectedAudioTrackID = engineID.flatMap(audioTrackIDs.opaqueID)

    case .selectedSubtitle(let engineID):
      selectedSubtitleTrackID = engineID.flatMap(subtitleTrackIDs.opaqueID)

    case .subtitleCues(let cues):
      subtitleCues = cues

    case .firstFrame(let isReady):
      receiveFirstFrame(isReady)

    case .outputDynamicRange(let dynamicRange):
      updateOutputDynamicRange(dynamicRange)

    case .playerItem(let playerItem):
      publishNativeVideoCharacteristics(from: playerItem)

    case .clock(let state):
      receiveClock(state)
    }
  }

  private func receiveFirstFrame(_ isReady: Bool) {
    hasFirstFrame = isReady
    if isReady {
      publishNativeVideoCharacteristics()
    }
  }

  private func receiveClock(_ state: NamaPlayerClockState) {
    clock.update(state)
    if hasFirstFrame,
      videoCharacteristics?.width == nil || videoCharacteristics?.height == nil
    {
      publishNativeVideoCharacteristics()
    }
  }

  private func publishClock() {
    clock.update(
      NamaPlayerClockState(
        position: engine.clock.currentTime,
        duration: engine.duration,
        bufferedPosition: engine.clock.bufferedPosition,
        seekTarget: engine.seekTarget
      )
    )
  }

  private func publishTracks() {
    guard request != nil else {
      return
    }
    audioTracks = Self.audioTracks(engine.audioTracks, trackIDs: &audioTrackIDs)

    var externalOrdinal = 0
    subtitleTracks = engine.subtitleTracks.map { track in
      let preferredID: String?
      if track.isExternal {
        preferredID = request?.externalSubtitles[safe: externalOrdinal]?.trackID
        externalOrdinal += 1
      } else {
        preferredID = nil
      }
      let id = subtitleTrackIDs.assign(engineID: track.id, preferredID: preferredID)
      return NamaPlaybackSubtitleTrack(
        id: id,
        label: track.name,
        language: track.language,
        representation: Self.subtitleRepresentation(track.codec),
        isDefault: track.isDefault,
        isForced: track.isForced,
        isHearingImpaired: track.isHearingImpaired,
        isExternal: track.isExternal
      )
    }
    selectedAudioTrackID = engine.activeAudioTrackIndex.flatMap(audioTrackIDs.opaqueID)
    selectedSubtitleTrackID = engine.activeSubtitleTrackIndex.flatMap(
      subtitleTrackIDs.opaqueID
    )
  }

  private func publishVideoCharacteristics(from probe: SourceProbe?, mimeType: String?) {
    guard let probe else {
      return
    }
    videoCharacteristics = NamaPlaybackVideoCharacteristics(
      mimeType: mimeType,
      codec: probe.videoCodecName,
      width: probe.videoWidth > 0 ? Int(probe.videoWidth) : nil,
      height: probe.videoHeight > 0 ? Int(probe.videoHeight) : nil,
      frameRate: probe.videoFrameRate,
      sourceDynamicRange: Self.dynamicRange(probe.videoFormat),
      outputDynamicRange: Self.dynamicRange(engine.videoFormat),
      dolbyVisionProfile: probe.dvProfile
    )
  }

  private func publishNativeVideoCharacteristics(from playerItem: AVPlayerItem? = nil) {
    guard request != nil, let currentItem = playerItem ?? engine.currentAVPlayerItem else {
      return
    }
    let sourceDynamicRange = Self.dynamicRange(engine.sourceVideoFormat)
    let outputDynamicRange = Self.dynamicRange(engine.videoFormat)
    let dolbyVisionProfile = engine.sourceDVProfile
    let mimeType = request?.media.mimeType
    let presentationSize = currentItem.presentationSize
    videoCharacteristics = NamaPlaybackVideoCharacteristics(
      mimeType: mimeType,
      codec: videoCharacteristics?.codec,
      width: Self.positivePixelDimension(presentationSize.width),
      height: Self.positivePixelDimension(presentationSize.height),
      frameRate: engine.sourceVideoFrameRate,
      sourceDynamicRange: sourceDynamicRange,
      outputDynamicRange: outputDynamicRange,
      dolbyVisionProfile: dolbyVisionProfile
    )
  }

  private func updateOutputDynamicRange(_ dynamicRange: NamaPlaybackDynamicRange) {
    guard let current = videoCharacteristics else {
      return
    }
    videoCharacteristics = NamaPlaybackVideoCharacteristics(
      mimeType: current.mimeType,
      codec: current.codec,
      width: current.width,
      height: current.height,
      frameRate: current.frameRate,
      sourceDynamicRange: current.sourceDynamicRange,
      outputDynamicRange: dynamicRange,
      dolbyVisionProfile: current.dolbyVisionProfile
    )
  }

  private func reset(to state: NamaPlayerState) {
    self.state = state
    audioTracks = []
    subtitleTracks = []
    subtitleCues = []
    selectedAudioTrackID = nil
    selectedSubtitleTrackID = nil
    videoCharacteristics = nil
    hasFirstFrame = false
    clock.reset()
    audioTrackIDs.reset()
    subtitleTrackIDs.reset()
  }
}

private enum NamaPlayerObservation {
  case state(NamaPlayerState)
  case tracks
  case selectedAudio(Int?)
  case selectedSubtitle(Int?)
  case subtitleCues([NamaPlaybackSubtitleCue])
  case firstFrame(Bool)
  case outputDynamicRange(NamaPlaybackDynamicRange)
  case playerItem(AVPlayerItem?)
  case clock(NamaPlayerClockState)
}

private func makeAetherObservations(
  _ engine: AetherEngine,
  receive: @escaping (NamaPlayerObservation) -> Void
) -> Set<AnyCancellable> {
  var observations: Set<AnyCancellable> = []
  engine.$playbackPhase
    .sink { receive(.state(NamaPlayer.playerState($0))) }
    .store(in: &observations)
  engine.$audioTracks
    .sink { _ in receive(.tracks) }
    .store(in: &observations)
  engine.$subtitleTracks
    .sink { _ in receive(.tracks) }
    .store(in: &observations)
  engine.$subtitleCues
    .sink { receive(.subtitleCues(NamaPlayer.subtitleCues($0))) }
    .store(in: &observations)
  engine.$activeAudioTrackIndex
    .sink { receive(.selectedAudio($0)) }
    .store(in: &observations)
  engine.$activeSubtitleTrackIndex
    .sink { receive(.selectedSubtitle($0)) }
    .store(in: &observations)
  engine.$hasFirstFrameReadyForDisplay
    .sink { receive(.firstFrame($0)) }
    .store(in: &observations)
  engine.$videoFormat
    .sink { receive(.outputDynamicRange(NamaPlayer.dynamicRange($0))) }
    .store(in: &observations)
  engine.$currentAVPlayerItem
    .sink { receive(.playerItem($0)) }
    .store(in: &observations)
  engine.clock.$currentTime
    .combineLatest(
      engine.$duration,
      engine.clock.$bufferedPosition,
      engine.$seekTarget
    )
    .sink { position, duration, bufferedPosition, seekTarget in
      receive(
        .clock(
          NamaPlayerClockState(
            position: position,
            duration: duration,
            bufferedPosition: bufferedPosition,
            seekTarget: seekTarget
          )
        )
      )
    }
    .store(in: &observations)
  return observations
}
