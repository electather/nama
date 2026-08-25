import CoreGraphics
import Foundation
import Observation

nonisolated struct NamaPlaybackLocatorHeader: Sendable, Equatable {
  let name: String
  let value: String
}

nonisolated struct NamaPlaybackLocator: Sendable, Equatable {
  let url: URL
  let headers: [NamaPlaybackLocatorHeader]
  let allowedRedirectOrigins: [URL]
  let mimeType: String?

  var headerFields: [String: String] {
    var result: [String: String] = [:]
    for header in headers {
      result[header.name] = header.value
    }
    return result
  }

  var subtitleFormatHint: String? {
    guard let mediaType = mimeType?.lowercased().split(separator: ";", maxSplits: 1).first
    else {
      return nil
    }
    switch mediaType {
    case "application/x-subrip", "application/srt", "text/srt":
      return "srt"

    case "text/vtt":
      return "vtt"

    case "text/x-ass", "text/x-ssa":
      return "ass"

    default:
      return nil
    }
  }
}

nonisolated struct NamaExternalSubtitleLocator: Sendable, Equatable {
  let trackID: String
  let label: String
  let language: String?
  let isDefault: Bool
  let isForced: Bool
  var isHearingImpaired = false
  let locator: NamaPlaybackLocator
}

nonisolated struct NamaPlayerRequest: Sendable, Equatable {
  let media: NamaPlaybackLocator
  let resumePosition: TimeInterval?
  let externalSubtitles: [NamaExternalSubtitleLocator]
}

nonisolated enum NamaPlayerState: Sendable, Equatable {
  case idle
  case loading
  case playing
  case paused
  case seeking
  case buffering
  case ended
  case failed(NamaPlaybackFailure)
}

nonisolated enum NamaPlaybackFailureCategory: Sendable, Equatable {
  case network
  case unsupportedMedia
  case playbackUnavailable
  case unknown
}

nonisolated struct NamaPlaybackFailure: Sendable, Equatable {
  let category: NamaPlaybackFailureCategory
  let summary: LocalizedStringResource

  static func sanitized(_ category: NamaPlaybackFailureCategory) -> Self {
    let safeSummary: LocalizedStringResource =
      switch category {
      case .network:
        "The media source could not be reached."

      case .unsupportedMedia:
        "This media format is not supported."

      case .playbackUnavailable:
        "Playback is temporarily unavailable."

      case .unknown:
        "Playback could not continue."
      }
    return Self(category: category, summary: safeSummary)
  }
}

nonisolated struct NamaPlayerInitializationError: Error, Sendable, Equatable {
  let failure = NamaPlaybackFailure(
    category: .playbackUnavailable,
    summary: "Playback is unavailable on this device."
  )
}

nonisolated struct NamaPlayerClockState: Sendable, Equatable {
  let position: TimeInterval
  let duration: TimeInterval?
  let bufferedPosition: TimeInterval
  let seekTarget: TimeInterval?

  init(
    position: TimeInterval = 0,
    duration: TimeInterval? = nil,
    bufferedPosition: TimeInterval = 0,
    seekTarget: TimeInterval? = nil
  ) {
    let normalizedDuration = duration.flatMap(Self.positiveFinite)
    self.duration = normalizedDuration
    self.position = Self.clamp(position, duration: normalizedDuration)
    self.bufferedPosition = Self.clamp(bufferedPosition, duration: normalizedDuration)
    self.seekTarget = seekTarget.map { Self.clamp($0, duration: normalizedDuration) }
  }

  func clampedSeekTarget(_ target: TimeInterval) -> TimeInterval {
    Self.clamp(target, duration: duration)
  }

  static func nonnegativeFinite(_ value: TimeInterval) -> TimeInterval? {
    value.isFinite ? max(0, value) : nil
  }

  private static func clamp(
    _ value: TimeInterval,
    duration: TimeInterval?
  ) -> TimeInterval {
    let finiteValue = value.isFinite ? max(0, value) : 0
    return duration.map { min(finiteValue, $0) } ?? finiteValue
  }

  private static func positiveFinite(_ value: TimeInterval) -> TimeInterval? {
    value.isFinite && value > 0 ? value : nil
  }
}

@MainActor
@Observable
final class NamaPlayerClock {
  private(set) var state = NamaPlayerClockState()

  func update(_ state: NamaPlayerClockState) {
    self.state = state
  }

  func reset() {
    state = NamaPlayerClockState()
  }
}

nonisolated struct NamaPlaybackAudioTrack: Sendable, Equatable, Identifiable {
  let id: String
  let label: String
  let language: String?
  let codec: String?
  let channelCount: Int?
  let isDefault: Bool
  let isCommentary: Bool
  let isAtmos: Bool
}

nonisolated enum NamaPlaybackSubtitleRepresentation: Sendable, Equatable {
  case text
  case image
}

nonisolated struct NamaPlaybackSubtitleTrack: Sendable, Equatable, Identifiable {
  let id: String
  let label: String
  let language: String?
  let representation: NamaPlaybackSubtitleRepresentation
  let isDefault: Bool
  let isForced: Bool
  let isHearingImpaired: Bool
  let isExternal: Bool
}

nonisolated struct NamaPlaybackSubtitleCue: @unchecked Sendable, Identifiable {
  enum Body: @unchecked Sendable {
    case text(String)
    case image(CGImage, position: CGRect, canvasSize: CGSize)
  }

  let id: String
  let startTime: TimeInterval
  let endTime: TimeInterval
  let body: Body
  let placement: NamaPlaybackSubtitleTextPlacement?
}

nonisolated struct NamaPlaybackSubtitleTextPlacement: Sendable {
  let alignment: Int?
  let position: CGPoint?
}

nonisolated enum NamaPlaybackDynamicRange: Sendable, Equatable {
  case sdr
  case hdr10
  case hdr10Plus
  case dolbyVision
  case hlg
}

nonisolated struct NamaPlaybackVideoCharacteristics: Sendable, Equatable {
  let mimeType: String?
  let codec: String?
  let width: Int?
  let height: Int?
  let frameRate: Double?
  let sourceDynamicRange: NamaPlaybackDynamicRange
  let outputDynamicRange: NamaPlaybackDynamicRange
  let dolbyVisionProfile: Int?
}

nonisolated struct OpaquePlaybackTrackIDs {
  private var opaqueIDsByEngineID: [Int: String] = [:]
  private var engineIDsByOpaqueID: [String: Int] = [:]

  mutating func assign(engineID: Int, preferredID: String? = nil) -> String {
    if let existing = opaqueIDsByEngineID[engineID] {
      return existing
    }
    let opaqueID = preferredID ?? UUID().uuidString
    opaqueIDsByEngineID[engineID] = opaqueID
    engineIDsByOpaqueID[opaqueID] = engineID
    return opaqueID
  }

  func opaqueID(for engineID: Int) -> String? {
    opaqueIDsByEngineID[engineID]
  }

  func engineID(for opaqueID: String) -> Int? {
    engineIDsByOpaqueID[opaqueID]
  }

  mutating func reset() {
    opaqueIDsByEngineID = [:]
    engineIDsByOpaqueID = [:]
  }
}

extension Collection {
  subscript(safe index: Index) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
