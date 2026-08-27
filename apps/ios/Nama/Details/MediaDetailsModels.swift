import Foundation

nonisolated struct MediaDetailsSelection: Equatable, Hashable, Sendable {
  let identity: MediaIdentity
  let kind: MediaKind?
  let title: String?

  init(identity: MediaIdentity, kind: MediaKind, title: String) {
    self.identity = identity
    self.kind = kind
    self.title = title
  }

  init(restoredIdentity: MediaIdentity) {
    identity = restoredIdentity
    kind = nil
    title = nil
  }
}

nonisolated struct MediaPlayIntent: Equatable, Hashable, Sendable {
  let mediaIdentity: MediaIdentity
}

nonisolated enum MediaDetailsArtworkSlot: Equatable, Hashable, Sendable {
  case poster
  case backdrop
}

nonisolated enum MediaCreditRole: Equatable, Hashable, Sendable {
  case actor
  case director
  case writer
}

nonisolated struct MediaCreditIdentity: Equatable, Hashable, Sendable {
  private enum Value: Equatable, Hashable, Sendable {
    case fixture(Int)
    case canonical(
      name: String,
      role: MediaCreditRole,
      characterName: String?,
      occurrence: Int
    )
  }

  private let value: Value

  init(_ rawValue: Int) {
    value = .fixture(rawValue)
  }

  init(
    name: String,
    role: MediaCreditRole,
    characterName: String?,
    occurrence: Int
  ) {
    value = .canonical(
      name: name,
      role: role,
      characterName: characterName,
      occurrence: occurrence
    )
  }
}

nonisolated struct MediaCreditIdentitySeed: Hashable, Sendable {
  let name: String
  let role: MediaCreditRole
  let characterName: String?
}

nonisolated struct MediaCredit: Equatable, Identifiable, Sendable {
  let identity: MediaCreditIdentity
  let name: String
  let role: MediaCreditRole
  let characterName: String?
  let portraitArtwork: ArtworkReference?

  var id: MediaCreditIdentity {
    identity
  }
}

nonisolated struct MediaCalendarDate: Equatable, Hashable, Sendable {
  let year: Int32?
  let month: Int32?
  let day: Int32?
}

nonisolated struct MediaDetailsParent: Equatable, Sendable {
  let identity: MediaIdentity
  let kind: MediaKind
  let title: String
}

nonisolated enum MediaDetailsKind: Equatable, Sendable {
  case movie(releaseDate: MediaCalendarDate?)
  case show(
    firstReleaseDate: MediaCalendarDate?,
    lastReleaseDate: MediaCalendarDate?,
    seasonCount: UInt32?,
    episodeCount: UInt32?
  )
  case season(seasonNumber: UInt32, episodeCount: UInt32?)
  case episode(
    seasonNumber: UInt32,
    episodeNumber: UInt32,
    releaseDate: MediaCalendarDate?
  )

  var mediaKind: MediaKind {
    switch self {
    case .movie:
      .movie

    case .show:
      .show

    case .season:
      .season

    case .episode:
      .episode
    }
  }
}

nonisolated struct MediaDetails: Equatable, Sendable {
  private static let initialCastLimit = 8
  let identity: MediaIdentity
  let title: String
  let releaseYear: UInt32?
  let runtime: Duration?
  let contentRating: String?
  let primaryGenre: String?
  let tagline: String?
  let synopsis: String?
  let genres: [String]
  let studios: [String]
  let credits: [MediaCredit]
  let artwork: [ArtworkReference]
  let parents: [MediaDetailsParent]
  let playability: MediaPlayability
  let defaultSource: MediaSourceSummary?
  let kindDetails: MediaDetailsKind

  var directors: [MediaCredit] {
    credits.filter { $0.role == .director }
  }

  var writers: [MediaCredit] {
    credits.filter { $0.role == .writer }
  }

  var cast: [MediaCredit] {
    credits.filter { $0.role == .actor }
  }

  var initialCast: [MediaCredit] {
    Array(cast.prefix(Self.initialCastLimit))
  }

  var selection: MediaDetailsSelection {
    MediaDetailsSelection(
      identity: identity,
      kind: kindDetails.mediaKind,
      title: title
    )
  }

  var preferredPosterArtwork: ArtworkReference? {
    preferredArtwork(for: .poster)
  }

  var preferredBackdropArtwork: ArtworkReference? {
    preferredArtwork(for: .backdrop)
  }

  private func preferredArtwork(for role: ArtworkRole) -> ArtworkReference? {
    artwork.first { reference in
      reference.role == role && reference.textPresence == .textless
    } ?? artwork.first { $0.role == role }
  }
}

nonisolated enum MediaDetailsFailure: Error, Equatable, Sendable {
  case notFound
  case catalogNotReady(retryAfterSeconds: Int?)
  case pageTokenInvalid
  case transportUnavailable
  case authorizationUnavailable
  case incompatible
  case namaUnavailable(requestID: String?, retryAfterSeconds: Int?)
}

nonisolated enum MediaDetailsState: Equatable, Sendable {
  case idle
  case loading(MediaDetailsSelection)
  case content(MediaDetails)
  case refreshing(MediaDetails)
  case refreshFailed(MediaDetails, MediaDetailsFailure)
  case failed(MediaDetailsSelection, MediaDetailsFailure)
}

nonisolated protocol MediaDetailsLoading: Sendable {
  func load(
    _ selection: MediaDetailsSelection,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaDetails
}

nonisolated struct MediaChildrenPage: Equatable, Sendable {
  let items: [MediaSummary]
  let nextPageToken: String?
}

nonisolated enum MediaChildrenPagePolicy {
  static let size: UInt32 = 50
}

nonisolated enum MediaChildrenState: Equatable, Sendable {
  case notApplicable
  case loading
  case content(items: [MediaSummary], nextPageToken: String?)
  case loadingMore(items: [MediaSummary], pageToken: String?)
  case pageFailed(
    items: [MediaSummary],
    pageToken: String?,
    failure: MediaDetailsFailure
  )

  var confirmedItems: [MediaSummary] {
    switch self {
    case .content(let items, _), .loadingMore(let items, _), .pageFailed(let items, _, _):
      items

    case .notApplicable, .loading:
      []
    }
  }
}

nonisolated protocol MediaChildrenLoading: Sendable {
  func loadChildren(
    for parent: MediaDetailsSelection,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaChildrenPage
}
