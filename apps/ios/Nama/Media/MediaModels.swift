import Foundation

nonisolated struct MediaIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated struct ArtworkIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated struct MediaSourceIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated enum MediaKind: Equatable, Hashable, Sendable {
  case movie
  case show
  case season
  case episode
}

nonisolated enum MediaPlayability: Equatable, Sendable {
  case playable
  case temporarilyUnavailable
  case noAvailableSource
  case unknown
}

nonisolated enum MediaSourceAvailability: Equatable, Sendable {
  case available
  case providerUnavailable
  case unsupported
  case unknown
}

nonisolated enum ArtworkRole: Equatable, Sendable {
  case poster
  case backdrop
  case logo
  case thumbnail
  case portrait
}

nonisolated enum ArtworkTextPresence: Equatable, Sendable {
  case unknown
  case textless
  case containsText
}

nonisolated struct ArtworkSizeBucket: Equatable, Hashable, Sendable {
  private static let minimumRequestedWidth = 0.0
  private static let backdropCompactWidth: UInt32 = 1_024
  private static let backdropStandardWidth: UInt32 = 1_536
  private static let backdropMaximumWidth: UInt32 = 1_920
  private static let backdropHeightNumerator: UInt32 = 9
  private static let backdropWidthDenominator: UInt32 = 16
  private static let compactWidth: UInt32 = 256
  private static let standardWidth: UInt32 = 384
  private static let largeWidth: UInt32 = 512
  private static let maximumWidth: UInt32 = 768
  private static let posterHeightIncrementDivisor: UInt32 = 2

  let maxWidth: UInt32
  let maxHeight: UInt32

  static func poster(displayWidth: Double, scale: Double) -> Self {
    let bucketWidth = coverBucketWidth(displayWidth: displayWidth, scale: scale)
    return Self(
      maxWidth: bucketWidth,
      maxHeight: bucketWidth + bucketWidth / posterHeightIncrementDivisor
    )
  }

  static func thumbnail(displayWidth: Double, scale: Double) -> Self {
    let bucketWidth = coverBucketWidth(displayWidth: displayWidth, scale: scale)
    return Self(
      maxWidth: bucketWidth,
      maxHeight: bucketWidth * backdropHeightNumerator / backdropWidthDenominator
    )
  }

  static func backdrop(displayWidth: Double, scale: Double) -> Self {
    let requestedWidth =
      displayWidth.isFinite && scale.isFinite
      ? max(minimumRequestedWidth, displayWidth * scale)
      : minimumRequestedWidth
    let bucketWidth =
      if requestedWidth <= Double(backdropCompactWidth) {
        backdropCompactWidth
      } else if requestedWidth <= Double(backdropStandardWidth) {
        backdropStandardWidth
      } else {
        backdropMaximumWidth
      }
    return Self(
      maxWidth: bucketWidth,
      maxHeight: bucketWidth * backdropHeightNumerator / backdropWidthDenominator
    )
  }

  private static func coverBucketWidth(displayWidth: Double, scale: Double) -> UInt32 {
    let requestedWidth =
      displayWidth.isFinite && scale.isFinite
      ? max(minimumRequestedWidth, displayWidth * scale)
      : minimumRequestedWidth
    return if requestedWidth <= Double(compactWidth) {
      compactWidth
    } else if requestedWidth <= Double(standardWidth) {
      standardWidth
    } else if requestedWidth <= Double(largeWidth) {
      largeWidth
    } else {
      maximumWidth
    }
  }
}

nonisolated enum MediaDynamicRange: Equatable, Sendable {
  case sdr
  case hdr10
  case hdr10Plus
  case hlg
  case dolbyVision
  case unknown
}

nonisolated enum MediaSpatialAudioFormat: Equatable, Sendable {
  case nonSpatial
  case dolbyAtmos
  case dtsX
  case unknown
}

nonisolated struct ArtworkReference: Equatable, Sendable {
  let identity: ArtworkIdentity
  let role: ArtworkRole
  let width: UInt32?
  let height: UInt32?
  let locale: String?
  let textPresence: ArtworkTextPresence
}

nonisolated struct MediaVideoQuality: Equatable, Sendable {
  let codec: String
  let width: UInt32?
  let height: UInt32?
  let dynamicRange: MediaDynamicRange?
}

nonisolated struct MediaAudioQuality: Equatable, Sendable {
  let codec: String
  let channelCount: UInt32?
  let spatialFormat: MediaSpatialAudioFormat?
}

nonisolated struct MediaSourceSummary: Equatable, Sendable {
  let identity: MediaSourceIdentity
  let label: String?
  let isDefault: Bool
  let availability: MediaSourceAvailability
  let container: String?
  let videoQuality: MediaVideoQuality?
  let audioQuality: MediaAudioQuality?
}

nonisolated struct MediaEpisodePosition: Equatable, Sendable {
  let seasonNumber: UInt32
  let episodeNumber: UInt32
}

nonisolated struct MediaSummary: Equatable, Identifiable, Sendable {
  let identity: MediaIdentity
  let kind: MediaKind
  let title: String
  let releaseYear: UInt32?
  let runtime: Duration?
  let contentRating: String?
  let primaryGenre: String?
  let episodePosition: MediaEpisodePosition?
  let artwork: [ArtworkReference]
  let playability: MediaPlayability
  let defaultSource: MediaSourceSummary?

  init(
    identity: MediaIdentity,
    kind: MediaKind,
    title: String,
    releaseYear: UInt32?,
    runtime: Duration?,
    contentRating: String?,
    primaryGenre: String?,
    artwork: [ArtworkReference],
    playability: MediaPlayability,
    defaultSource: MediaSourceSummary?,
    episodePosition: MediaEpisodePosition? = nil
  ) {
    self.identity = identity
    self.kind = kind
    self.title = title
    self.releaseYear = releaseYear
    self.runtime = runtime
    self.contentRating = contentRating
    self.primaryGenre = primaryGenre
    self.episodePosition = episodePosition
    self.artwork = artwork
    self.playability = playability
    self.defaultSource = defaultSource
  }

  var preferredPosterArtwork: ArtworkReference? {
    artwork.first { reference in
      reference.role == .poster && reference.textPresence == .textless
    }
  }

  var id: MediaIdentity {
    identity
  }
}
