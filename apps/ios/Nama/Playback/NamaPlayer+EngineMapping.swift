internal import AetherEngine
import Foundation

extension NamaPlayer {
  static func playerState(_ phase: PlaybackPhase) -> NamaPlayerState {
    switch phase {
    case .idle:
      .idle

    case .loading:
      .loading

    case .playing:
      .playing

    case .paused:
      .paused

    case .seeking:
      .seeking

    case .rebuffering, .stalled:
      .buffering

    case .ended:
      .ended

    case .error:
      .failed(NamaPlaybackFailure.sanitized(.unknown))
    }
  }

  static func dynamicRange(_ format: VideoFormat) -> NamaPlaybackDynamicRange {
    switch format {
    case .sdr:
      .sdr

    case .hdr10:
      .hdr10

    case .hdr10Plus:
      .hdr10Plus

    case .dolbyVision:
      .dolbyVision

    case .hlg:
      .hlg
    }
  }

  static func positivePixelDimension(_ value: CGFloat) -> Int? {
    value.isFinite && value > 0 ? Int(value.rounded()) : nil
  }

  static func audioTracks(
    _ tracks: [TrackInfo],
    trackIDs: inout OpaquePlaybackTrackIDs
  ) -> [NamaPlaybackAudioTrack] {
    tracks.map { track in
      NamaPlaybackAudioTrack(
        id: trackIDs.assign(engineID: track.id),
        label: track.name,
        language: track.language,
        codec: track.codec.isEmpty ? nil : track.codec,
        channelCount: track.channels > 0 ? track.channels : nil,
        isDefault: track.isDefault,
        isCommentary: track.isCommentary,
        isAtmos: track.isAtmos
      )
    }
  }

  static func subtitleRepresentation(
    _ codec: String
  ) -> NamaPlaybackSubtitleRepresentation {
    imageSubtitleCodecs.contains(codec) ? .image : .text
  }

  static func subtitleCues(_ cues: [SubtitleCue]) -> [NamaPlaybackSubtitleCue] {
    cues.map { cue in
      let body: NamaPlaybackSubtitleCue.Body =
        switch cue.body {
        case .text(let text):
          .text(text)

        case .richText(let runs):
          .text(runs.map(\.text).joined())

        case .image(let image):
          .image(
            image.cgImage,
            position: image.position,
            canvasSize: image.canvasSize
          )
        }
      return NamaPlaybackSubtitleCue(
        id: String(cue.id),
        startTime: cue.startTime,
        endTime: cue.endTime,
        body: body,
        placement: cue.placement.map { placement in
          NamaPlaybackSubtitleTextPlacement(
            alignment: placement.alignment,
            position: placement.position
          )
        }
      )
    }
  }

  static func externalSubtitle(
    _ subtitle: NamaExternalSubtitleLocator,
    url: URL
  ) -> ExternalSubtitleTrack {
    ExternalSubtitleTrack(
      url: url,
      name: subtitle.label,
      language: subtitle.language,
      isForced: subtitle.isForced,
      isHearingImpaired: subtitle.isHearingImpaired,
      isDefault: subtitle.isDefault,
      httpHeaders: subtitle.locator.headerFields,
      formatHint: subtitle.locator.subtitleFormatHint
    )
  }

  static func sanitizedFailure(_ underlyingError: Error) -> NamaPlaybackFailure {
    if underlyingError is URLError {
      return NamaPlaybackFailure.sanitized(.network)
    }
    if underlyingError is AetherEngineError {
      return NamaPlaybackFailure.sanitized(.unsupportedMedia)
    }
    if let hlsError = underlyingError as? HLSVideoEngine.HLSVideoEngineError {
      switch hlsError {
      case .openFailed:
        return NamaPlaybackFailure.sanitized(.network)

      case .noVideoStream, .unsupportedCodec, .zeroDuration, .unsupportedDVProfile:
        return NamaPlaybackFailure.sanitized(.unsupportedMedia)

      case .muxerInit, .alreadyStarted, .notStarted:
        return NamaPlaybackFailure.sanitized(.playbackUnavailable)
      }
    }
    if let hlsError = underlyingError as? HLSIngestError {
      switch hlsError {
      case .playlistUnreachable, .ingestStalled:
        return NamaPlaybackFailure.sanitized(.network)

      default:
        return NamaPlaybackFailure.sanitized(.playbackUnavailable)
      }
    }
    return NamaPlaybackFailure.sanitized(.unknown)
  }

  private static let imageSubtitleCodecs: Set<String> = [
    "dvb_subtitle", "dvd_subtitle", "hdmv_pgs_subtitle", "pgssub", "xsub",
  ]
}
