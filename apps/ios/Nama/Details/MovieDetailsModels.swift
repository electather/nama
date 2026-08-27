import Foundation

nonisolated struct MovieDetailsSelection: Equatable, Hashable, Sendable {
  let identity: HomeMediaIdentity
  let title: String
}

nonisolated struct MoviePlayIntent: Equatable, Hashable, Sendable {
  let mediaIdentity: HomeMediaIdentity
}

nonisolated enum MovieDetailsArtworkSlot: Equatable, Hashable, Sendable {
  case poster
  case backdrop
}

nonisolated struct MovieCreditIdentity: Equatable, Hashable, Sendable {
  let rawValue: Int

  init(_ rawValue: Int) {
    self.rawValue = rawValue
  }
}

nonisolated enum MovieCreditRole: Equatable, Sendable {
  case actor
  case director
  case writer
}

nonisolated struct MovieCredit: Equatable, Identifiable, Sendable {
  let identity: MovieCreditIdentity
  let name: String
  let role: MovieCreditRole
  let characterName: String?
  let portraitArtwork: HomeArtworkReference?

  var id: MovieCreditIdentity {
    identity
  }
}

nonisolated struct MovieDetails: Equatable, Sendable {
  private static let initialCastLimit = 8
  let identity: HomeMediaIdentity
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
  let artwork: [HomeArtworkReference]
  let playability: HomePlayability
  let defaultSource: HomeSourceSummary?

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

  var preferredPosterArtwork: HomeArtworkReference? {
    preferredArtwork(for: .poster)
  }

  var preferredBackdropArtwork: HomeArtworkReference? {
    preferredArtwork(for: .backdrop)
  }

  private func preferredArtwork(for role: HomeArtworkRole) -> HomeArtworkReference? {
    artwork.first { reference in
      reference.role == role && reference.textPresence == .textless
    } ?? artwork.first { $0.role == role }
  }
}

nonisolated enum MovieDetailsFailure: Error, Equatable, Sendable {
  case notFound
  case transportUnavailable
  case authorizationUnavailable
  case incompatible
  case namaUnavailable(requestID: String?)
}

nonisolated enum MovieDetailsState: Equatable, Sendable {
  case idle
  case loading(MovieDetailsSelection)
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
