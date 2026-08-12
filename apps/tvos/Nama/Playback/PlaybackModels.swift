import CoreGraphics
import Foundation
import Observation

struct PlaybackMediaLocator: Sendable {
  let url: URL
  let httpHeaders: [String: String]
  let allowedRedirectOrigins: [URL]
  let mimeType: String?
}

struct PlaybackExternalSubtitleLocator: Sendable, Identifiable {
  let id: String
  let label: String
  let language: String?
  let isDefault: Bool
  let isForced: Bool
  let locator: PlaybackMediaLocator
}

struct PlaybackRequest: Sendable {
  let media: PlaybackMediaLocator
  let externalSubtitles: [PlaybackExternalSubtitleLocator]
  let resumePosition: TimeInterval?
}

struct PlaybackLifecycleGate {
  private var generation: UInt64 = 0
  private var hasRequest = false
  private var isLoading = false

  mutating func beginLoad() -> UInt64 {
    generation &+= 1
    hasRequest = true
    isLoading = true
    return generation
  }

  mutating func cancel() {
    generation &+= 1
    hasRequest = false
    isLoading = false
  }

  func permitsTerminalPublication(for candidate: UInt64) -> Bool {
    generation == candidate
  }

  var acceptsEngineObservations: Bool {
    hasRequest && !isLoading
  }

  mutating func finishLoad(for candidate: UInt64) -> Bool {
    guard permitsTerminalPublication(for: candidate) else { return false }
    isLoading = false
    return true
  }
}

enum PlaybackSubtitleGeometry {
  static func imageRect(
    position: CGRect,
    canvasSize: CGSize,
    displaySize: CGSize
  ) -> CGRect {
    guard canvasSize != .zero, canvasSize.width > 0 else {
      return CGRect(
        x: position.minX * displaySize.width,
        y: position.minY * displaySize.height,
        width: position.width * displaySize.width,
        height: position.height * displaySize.height
      )
    }

    let scale = displaySize.width / canvasSize.width
    return CGRect(
      x: position.minX * canvasSize.width * scale,
      y: displaySize.height / 2
        + (position.minY * canvasSize.height - canvasSize.height / 2) * scale,
      width: position.width * canvasSize.width * scale,
      height: position.height * canvasSize.height * scale
    )
  }
}

enum PlaybackState: Sendable, Equatable {
  case idle
  case loading
  case playing
  case paused
  case seeking
  case ended
  case failed(PlaybackFailure)
}

struct PlaybackClockState: Sendable, Equatable {
  var currentTime: TimeInterval = 0
  var duration: TimeInterval = 0
  var bufferedPosition: TimeInterval = 0
  var seekTarget: TimeInterval?
}

@MainActor
@Observable
final class NamaPlaybackClock {
  var state = PlaybackClockState()

  func reset() {
    state = PlaybackClockState()
  }
}

struct PlaybackAudioTrack: Sendable, Equatable, Identifiable {
  let id: String
  let label: String
  let language: String?
  let codec: String?
  let channelCount: Int?
  let isDefault: Bool
  let isCommentary: Bool
  let isAtmos: Bool
}

enum PlaybackSubtitleRepresentation: Sendable, Equatable {
  case text
  case image
}

struct PlaybackSubtitleTrack: Sendable, Equatable, Identifiable {
  let id: String
  let label: String
  let language: String?
  let representation: PlaybackSubtitleRepresentation
  let isDefault: Bool
  let isForced: Bool
  let isHearingImpaired: Bool
  let isExternal: Bool
}

struct PlaybackSubtitleCue: @unchecked Sendable, Identifiable {
  enum Body: @unchecked Sendable {
    case text(String)
    case image(CGImage, position: CGRect, canvasSize: CGSize)
  }

  let id: String
  let startTime: TimeInterval
  let endTime: TimeInterval
  let body: Body
  let textPlacement: CGPoint?
  let isForced: Bool
}

enum PlaybackDynamicRange: Sendable, Equatable {
  case sdr
  case hdr10
  case hdr10Plus
  case dolbyVision
  case hlg
}

struct PlaybackVideoDiagnostics: Sendable, Equatable {
  let container: String?
  let codec: String?
  let width: Int?
  let height: Int?
  let frameRate: Double?
  let sourceDynamicRange: PlaybackDynamicRange
  let outputDynamicRange: PlaybackDynamicRange
  let dolbyVisionProfile: Int?
}

enum PlaybackFailureCategory: Sendable, Equatable {
  case network
  case unsupportedMedia
  case playbackUnavailable
  case unknown
}

enum PlaybackRecoveryAction: Sendable, Equatable {
  case retry
  case backToFixtures
}

struct PlaybackFailure: Sendable, Equatable {
  let category: PlaybackFailureCategory
  let summary: String
  let recoveryAction: PlaybackRecoveryAction
}
