import Foundation

nonisolated struct MediaPartIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated enum MediaSubtitleRepresentation: Equatable, Sendable {
  case text
  case image
  case unknown
}

nonisolated struct MediaVideoTrack: Equatable, Sendable {
  let codec: String
  let width: UInt32?
  let height: UInt32?
  let frameRate: Double?
  let bitDepth: UInt32?
  let dynamicRange: MediaDynamicRange?
}

nonisolated struct MediaAudioTrack: Equatable, Sendable {
  let codec: String
  let title: String?
  let language: String?
  let channelCount: UInt32?
  let channelLayout: String?
  let sampleRateHz: UInt32?
  let spatialFormat: MediaSpatialAudioFormat?
  let isDefault: Bool
  let isCommentary: Bool
}

nonisolated struct MediaSubtitleTrack: Equatable, Sendable {
  let codec: String
  let title: String?
  let language: String?
  let representation: MediaSubtitleRepresentation
  let isDefault: Bool
  let isForced: Bool
  let isHearingImpaired: Bool
  let isCommentary: Bool
}

nonisolated enum MediaTrackDetails: Equatable, Sendable {
  case video(MediaVideoTrack)
  case audio(MediaAudioTrack)
  case subtitle(MediaSubtitleTrack)
  case unknown
}

nonisolated struct MediaTrack: Equatable, Sendable {
  let order: UInt32
  let details: MediaTrackDetails
}

nonisolated struct MediaPart: Equatable, Sendable {
  let identity: MediaPartIdentity
  let order: UInt32
  let container: String
  let runtime: Duration?
  let sizeBytes: UInt64?
  let bitRateBps: UInt64?
  let tracks: [MediaTrack]
}

nonisolated struct MediaSource: Equatable, Sendable {
  let identity: MediaSourceIdentity
  let mediaIdentity: MediaIdentity
  let label: String?
  let availability: MediaSourceAvailability
  let runtime: Duration?
  let bitRateBps: UInt64?
  let parts: [MediaPart]
}

nonisolated protocol MediaSourceLoading: Sendable {
  func loadSource(
    mediaIdentity: MediaIdentity,
    sourceIdentity: MediaSourceIdentity,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaSource
}

nonisolated enum MediaSourceFailure: Error, Equatable, Sendable {
  case missing
  case catalogNotReady(retryAfterSeconds: Int?)
  case unavailable
  case canceled
  case authorizationUnavailable
  case incompatible
  case stale
}

nonisolated enum MediaSourcesState: Equatable, Sendable {
  case idle
  case choosing(MediaSourcesSelection)
  case loading(MediaSourcesSelection, MediaSourceSummary)
  case inspected(MediaSourcesSelection, MediaSourceSummary, MediaSource)
  case failed(MediaSourcesSelection, MediaSourceSummary, MediaSourceFailure)
}
