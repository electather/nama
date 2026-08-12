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

enum PlaybackPresentationGeometry {
  static func aspectFitRect(presentationSize: CGSize, in bounds: CGRect) -> CGRect {
    guard presentationSize.width > 0, presentationSize.height > 0,
      presentationSize.width.isFinite, presentationSize.height.isFinite,
      bounds.width > 0, bounds.height > 0
    else {
      return bounds
    }

    let scale = min(
      bounds.width / presentationSize.width,
      bounds.height / presentationSize.height
    )
    let size = CGSize(
      width: presentationSize.width * scale,
      height: presentationSize.height * scale
    )
    return CGRect(
      x: bounds.midX - size.width / 2,
      y: bounds.midY - size.height / 2,
      width: size.width,
      height: size.height
    )
  }
}

enum PlaybackSubtitleHorizontalAnchor: Sendable, Equatable {
  case leading
  case center
  case trailing
}

enum PlaybackSubtitleVerticalAnchor: Sendable, Equatable {
  case top
  case center
  case bottom
}

struct PlaybackSubtitleTextPlacement: Sendable, Equatable {
  let alignment: Int?
  let position: CGPoint?
}

struct PlaybackSubtitleTextLayout: Sendable, Equatable {
  let point: CGPoint
  let horizontalAnchor: PlaybackSubtitleHorizontalAnchor
  let verticalAnchor: PlaybackSubtitleVerticalAnchor

  func offset(in contentRect: CGRect) -> CGSize {
    let anchorX =
      switch horizontalAnchor {
      case .leading: contentRect.minX
      case .center: contentRect.midX
      case .trailing: contentRect.maxX
      }
    let anchorY =
      switch verticalAnchor {
      case .top: contentRect.minY
      case .center: contentRect.midY
      case .bottom: contentRect.maxY
      }
    return CGSize(width: point.x - anchorX, height: point.y - anchorY)
  }
}

enum PlaybackSubtitleGeometry {
  static func imageRect(
    position: CGRect,
    canvasSize: CGSize,
    contentRect: CGRect
  ) -> CGRect {
    guard canvasSize != .zero, canvasSize.width > 0 else {
      return CGRect(
        x: contentRect.minX + position.minX * contentRect.width,
        y: contentRect.minY + position.minY * contentRect.height,
        width: position.width * contentRect.width,
        height: position.height * contentRect.height
      )
    }

    let scale = contentRect.width / canvasSize.width
    return CGRect(
      x: contentRect.minX + position.minX * canvasSize.width * scale,
      y: contentRect.midY
        + (position.minY * canvasSize.height - canvasSize.height / 2) * scale,
      width: position.width * canvasSize.width * scale,
      height: position.height * canvasSize.height * scale
    )
  }

  static func textLayout(
    placement: PlaybackSubtitleTextPlacement?,
    contentRect: CGRect
  ) -> PlaybackSubtitleTextLayout {
    let requestedAlignment = placement?.alignment ?? 2
    let alignment = (1...9).contains(requestedAlignment) ? requestedAlignment : 2
    let column = (alignment - 1) % 3
    let row = (alignment - 1) / 3
    let horizontalAnchor: PlaybackSubtitleHorizontalAnchor =
      switch column {
      case 0: .leading
      case 2: .trailing
      default: .center
      }
    let verticalAnchor: PlaybackSubtitleVerticalAnchor =
      switch row {
      case 0: .bottom
      case 2: .top
      default: .center
      }

    let point: CGPoint
    if let position = placement?.position {
      point = CGPoint(
        x: contentRect.minX + min(max(position.x, 0), 1) * contentRect.width,
        y: contentRect.minY + min(max(position.y, 0), 1) * contentRect.height
      )
    } else {
      let horizontalMargin = contentRect.width * 0.05
      let verticalMargin = contentRect.height * 0.08
      let x: CGFloat =
        switch horizontalAnchor {
        case .leading: contentRect.minX + horizontalMargin
        case .center: contentRect.midX
        case .trailing: contentRect.maxX - horizontalMargin
        }
      let y: CGFloat =
        switch verticalAnchor {
        case .top: contentRect.minY + verticalMargin
        case .center: contentRect.midY
        case .bottom: contentRect.maxY - verticalMargin
        }
      point = CGPoint(x: x, y: y)
    }

    return PlaybackSubtitleTextLayout(
      point: point,
      horizontalAnchor: horizontalAnchor,
      verticalAnchor: verticalAnchor
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
  let textPlacement: PlaybackSubtitleTextPlacement?
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
