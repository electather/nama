import AetherEngine
import Foundation

enum AetherPlaybackMapping {
  static func state(_ state: PlaybackState) -> NamaPlaybackState {
    switch state {
    case .idle: .idle
    case .loading: .loading
    case .playing: .playing
    case .paused: .paused
    case .seeking: .seeking
    case .ended: .ended
    case .error: .failed(failure(category: .unknown))
    }
  }

  static func audioTrack(_ track: TrackInfo) -> PlaybackAudioTrack {
    PlaybackAudioTrack(
      id: String(track.id),
      label: track.name,
      language: track.language,
      codec: track.codec.isEmpty ? nil : track.codec,
      channelCount: track.channels == 0 ? nil : track.channels,
      isDefault: track.isDefault,
      isCommentary: track.isCommentary,
      isAtmos: track.isAtmos
    )
  }

  static func subtitleTrack(_ track: TrackInfo) -> PlaybackSubtitleTrack {
    PlaybackSubtitleTrack(
      id: String(track.id),
      label: track.name,
      language: track.language,
      representation: imageSubtitleCodecs.contains(track.codec) ? .image : .text,
      isDefault: track.isDefault,
      isForced: track.isForced,
      isHearingImpaired: track.isHearingImpaired,
      isExternal: track.isExternal
    )
  }

  static func subtitleCue(_ cue: SubtitleCue) -> PlaybackSubtitleCue {
    let body: PlaybackSubtitleCue.Body =
      switch cue.body {
      case .text(let text): .text(text)
      case .richText(let runs): .text(runs.map(\.text).joined())
      case .image(let image):
        .image(image.cgImage, position: image.position, canvasSize: image.canvasSize)
      }

    return PlaybackSubtitleCue(
      id: String(cue.id),
      startTime: cue.startTime,
      endTime: cue.endTime,
      body: body,
      textPlacement: cue.placement.map {
        PlaybackSubtitleTextPlacement(alignment: $0.alignment, position: $0.position)
      },
      isForced: cue.isForced
    )
  }

  static func presentationSize(_ size: CGSize?) -> CGSize? {
    guard let size, size.width > 0, size.height > 0,
      size.width.isFinite, size.height.isFinite
    else {
      return nil
    }
    return size
  }

  static func dynamicRange(_ format: VideoFormat) -> PlaybackDynamicRange {
    switch format {
    case .sdr: .sdr
    case .hdr10: .hdr10
    case .hdr10Plus: .hdr10Plus
    case .dolbyVision: .dolbyVision
    case .hlg: .hlg
    }
  }

  static func videoDiagnostics(
    probe: SourceProbe,
    container: String?,
    outputDynamicRange: VideoFormat
  ) -> PlaybackVideoDiagnostics {
    PlaybackVideoDiagnostics(
      container: container,
      codec: probe.videoCodecName,
      width: probe.videoWidth == 0 ? nil : Int(probe.videoWidth),
      height: probe.videoHeight == 0 ? nil : Int(probe.videoHeight),
      frameRate: probe.videoFrameRate,
      sourceDynamicRange: dynamicRange(probe.videoFormat),
      outputDynamicRange: dynamicRange(outputDynamicRange),
      dolbyVisionProfile: probe.dvProfile
    )
  }

  static func failure(_ error: Error) -> PlaybackFailure {
    if error is URLError {
      return failure(category: .network)
    }
    if error is AetherEngineError || error is HLSVideoEngine.HLSVideoEngineError {
      return failure(category: .unsupportedMedia)
    }
    if let error = error as? HLSIngestError {
      switch error {
      case .playlistUnreachable, .ingestStalled:
        return failure(category: .network)
      default:
        return failure(category: .playbackUnavailable)
      }
    }
    return failure(category: .unknown)
  }

  private static let imageSubtitleCodecs: Set<String> = [
    "dvb_subtitle", "dvd_subtitle", "hdmv_pgs_subtitle", "pgssub",
  ]

  private static func failure(category: PlaybackFailureCategory) -> PlaybackFailure {
    let summary =
      switch category {
      case .network: "The media source could not be reached."
      case .unsupportedMedia: "This media format is not supported."
      case .playbackUnavailable: "Playback is temporarily unavailable."
      case .unknown: "Playback could not continue."
      }
    return PlaybackFailure(category: category, summary: summary, recoveryAction: .retry)
  }
}
