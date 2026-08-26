import Foundation

nonisolated struct HomeAuthorizationIdentity: Equatable, Hashable, Sendable {
  let endpoint: NamaEndpoint
  let accessTokenExpiresAt: Date
  let generation: UInt64

  init(
    endpoint: NamaEndpoint,
    accessTokenExpiresAt: Date,
    generation: UInt64
  ) {
    self.endpoint = endpoint
    self.accessTokenExpiresAt = accessTokenExpiresAt
    self.generation = generation
  }

  init?(
    currentEndpoint: NamaEndpoint,
    authorizationState: OAuthAuthorizationState,
    generation: UInt64
  ) {
    guard
      case .authorized(let authorization) = authorizationState,
      authorization.endpoint == currentEndpoint
    else {
      return nil
    }
    self.init(
      endpoint: authorization.endpoint,
      accessTokenExpiresAt: authorization.accessTokenExpiresAt,
      generation: generation
    )
  }
}

nonisolated struct HomeShelfIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated struct HomeMediaIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated struct HomeArtworkIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated struct HomeSourceIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated enum HomeShelfKind: Equatable, Sendable {
  case movies
  case shows
}

nonisolated enum HomeMediaKind: Equatable, Sendable {
  case movie
  case show
}

nonisolated enum HomePlayability: Equatable, Sendable {
  case playable
  case temporarilyUnavailable
  case noAvailableSource
  case unknown
}

nonisolated enum HomeSourceAvailability: Equatable, Sendable {
  case available
  case providerUnavailable
  case unsupported
  case unknown
}

nonisolated enum HomeArtworkRole: Equatable, Sendable {
  case poster
  case backdrop
  case logo
  case thumbnail
  case portrait
}

nonisolated enum HomeArtworkTextPresence: Equatable, Sendable {
  case unknown
  case textless
  case containsText
}

nonisolated struct HomeArtworkSizeBucket: Equatable, Hashable, Sendable {
  private static let minimumRequestedWidth = 0.0
  private static let compactWidth: UInt32 = 256
  private static let standardWidth: UInt32 = 384
  private static let largeWidth: UInt32 = 512
  private static let maximumWidth: UInt32 = 768
  private static let posterHeightIncrementDivisor: UInt32 = 2

  let maxWidth: UInt32
  let maxHeight: UInt32

  static func poster(displayWidth: Double, scale: Double) -> Self {
    let requestedWidth =
      displayWidth.isFinite && scale.isFinite
      ? max(minimumRequestedWidth, displayWidth * scale)
      : minimumRequestedWidth
    let bucketWidth =
      if requestedWidth <= Double(compactWidth) {
        compactWidth
      } else if requestedWidth <= Double(standardWidth) {
        standardWidth
      } else if requestedWidth <= Double(largeWidth) {
        largeWidth
      } else {
        maximumWidth
      }
    return Self(
      maxWidth: bucketWidth,
      maxHeight: bucketWidth + bucketWidth / posterHeightIncrementDivisor
    )
  }
}

nonisolated enum HomeDynamicRange: Equatable, Sendable {
  case sdr
  case hdr10
  case hdr10Plus
  case hlg
  case dolbyVision
  case unknown
}

nonisolated enum HomeSpatialAudioFormat: Equatable, Sendable {
  case nonSpatial
  case dolbyAtmos
  case dtsX
  case unknown
}

nonisolated struct HomeArtworkReference: Equatable, Sendable {
  let identity: HomeArtworkIdentity
  let role: HomeArtworkRole
  let width: UInt32?
  let height: UInt32?
  let locale: String?
  let textPresence: HomeArtworkTextPresence
}

nonisolated struct HomeVideoQuality: Equatable, Sendable {
  let codec: String
  let width: UInt32?
  let height: UInt32?
  let dynamicRange: HomeDynamicRange?
}

nonisolated struct HomeAudioQuality: Equatable, Sendable {
  let codec: String
  let channelCount: UInt32?
  let spatialFormat: HomeSpatialAudioFormat?
}

nonisolated struct HomeSourceSummary: Equatable, Sendable {
  let identity: HomeSourceIdentity
  let label: String?
  let isDefault: Bool
  let availability: HomeSourceAvailability
  let container: String?
  let videoQuality: HomeVideoQuality?
  let audioQuality: HomeAudioQuality?
}

nonisolated struct HomeMediaSummary: Equatable, Identifiable, Sendable {
  let identity: HomeMediaIdentity
  let kind: HomeMediaKind
  let title: String
  let releaseYear: UInt32?
  let runtime: Duration?
  let contentRating: String?
  let primaryGenre: String?
  let artwork: [HomeArtworkReference]
  let playability: HomePlayability
  let defaultSource: HomeSourceSummary?

  var preferredPosterArtwork: HomeArtworkReference? {
    artwork.first { reference in
      reference.role == .poster && reference.textPresence == .textless
    }
  }

  var id: HomeMediaIdentity {
    identity
  }
}

nonisolated struct HomeShelf: Equatable, Identifiable, Sendable {
  let identity: HomeShelfIdentity
  let title: String
  let kind: HomeShelfKind
  let items: [HomeMediaSummary]

  var id: HomeShelfIdentity {
    identity
  }
}

nonisolated struct HomeSnapshot: Equatable, Sendable {
  let shelves: [HomeShelf]

  init(movies: HomeShelf?, shows: HomeShelf?) {
    shelves = [movies, shows].compactMap { shelf in
      guard let shelf, !shelf.items.isEmpty else {
        return nil
      }
      return shelf
    }
  }

  var movies: HomeShelf? {
    shelves.first { $0.kind == .movies }
  }

  var shows: HomeShelf? {
    shelves.first { $0.kind == .shows }
  }

  var isEmpty: Bool {
    shelves.isEmpty
  }
}

nonisolated enum HomeLoadingFailure: Error, Equatable, Sendable {
  case catalogNotReady(retryAfterSeconds: Int?)
  case authorizationUnavailable
  case networkUnavailable
  case namaUnavailable(requestID: String?)
  case incompatible
}

nonisolated enum HomeState: Equatable, Sendable {
  case loading
  case catalogNotReady(retryAfterSeconds: Int?)
  case empty
  case content(HomeSnapshot)
  case refreshing(HomeSnapshot)
  case refreshFailed(HomeSnapshot, HomeLoadingFailure)
  case failed(HomeLoadingFailure)
}

nonisolated protocol HomeLoading: Sendable {
  func load(for authorization: HomeAuthorizationIdentity) async throws -> HomeSnapshot
}
