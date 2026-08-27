import Foundation

nonisolated struct MovieDetailsSelection: Equatable, Hashable, Sendable {
  let identity: MediaIdentity
  let title: String
}

nonisolated struct MoviePlayIntent: Equatable, Hashable, Sendable {
  let mediaIdentity: MediaIdentity
}

nonisolated enum MovieDetailsArtworkSlot: Equatable, Hashable, Sendable {
  case poster
  case backdrop
}

nonisolated enum MovieCreditRole: Equatable, Hashable, Sendable {
  case actor
  case director
  case writer
}

nonisolated struct MovieCreditIdentity: Equatable, Hashable, Sendable {
  let name: String
  let role: MovieCreditRole
  let characterName: String?
  let occurrence: Int
}

nonisolated struct MovieCredit: Equatable, Identifiable, Sendable {
  let identity: MovieCreditIdentity
  let name: String
  let role: MovieCreditRole
  let characterName: String?

  init(
    name: String,
    role: MovieCreditRole,
    characterName: String?,
    occurrence: Int = .zero
  ) {
    identity = MovieCreditIdentity(
      name: name,
      role: role,
      characterName: characterName,
      occurrence: occurrence
    )
    self.name = name
    self.role = role
    self.characterName = characterName
  }

  var id: MovieCreditIdentity {
    identity
  }
}

nonisolated struct MovieDetails: Equatable, Sendable {
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
  let credits: [MovieCredit]
  let artwork: [ArtworkReference]
  let playability: MediaPlayability
  let defaultSource: MediaSourceSummary?

  var directors: [MovieCredit] {
    credits.filter { $0.role == .director }
  }

  var writers: [MovieCredit] {
    credits.filter { $0.role == .writer }
  }

  var cast: [MovieCredit] {
    credits.filter { $0.role == .actor }
  }

  var initialCast: [MovieCredit] {
    Array(cast.prefix(Self.initialCastLimit))
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

nonisolated enum MovieDetailsFailure: Error, Equatable, Sendable {
  case notFound
  case catalogNotReady(retryAfterSeconds: Int?)
  case transportUnavailable
  case authorizationUnavailable
  case incompatible
  case namaUnavailable(requestID: String?, retryAfterSeconds: Int?)
}

nonisolated enum MovieDetailsState: Equatable, Sendable {
  case idle
  case loading(MovieDetailsSelection)
  case catalogNotReady(MovieDetailsSelection, retryAfterSeconds: Int?)
  case content(MovieDetails)
  case refreshing(MovieDetails)
  case refreshFailed(MovieDetails, MovieDetailsFailure)
  case failed(MovieDetailsSelection, MovieDetailsFailure)
}

nonisolated protocol MovieDetailsLoading: Sendable {
  func load(
    _ selection: MovieDetailsSelection,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MovieDetails
}
