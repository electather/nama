import Connect
import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient: MovieDetailsLoading {
  func load(
    _ selection: MovieDetailsSelection,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MovieDetails {
    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw MovieDetailsFailure.authorizationUnavailable
    }

    var request = Nama_Api_V1_GetMediaRequest()
    request.mediaID = selection.identity.rawValue
    let response = await libraryClient(using: record).getMedia(request: request)
    if Task.isCancelled {
      throw CancellationError()
    }
    switch response.result {
    case .success(let value):
      do {
        return try Self.mapMovieDetailsResponse(value, selection: selection)
      } catch {
        throw MovieDetailsFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapMovieDetailsFailure(error)
    }
  }

  static func mapMovieDetailsResponse(
    _ response: Nama_Api_V1_GetMediaResponse,
    selection: MovieDetailsSelection
  ) throws -> MovieDetails {
    guard response.hasMedia else {
      throw MovieDetailsResponseMappingError.invalid
    }
    let media = response.media
    try validateMovieDetailsShape(media)

    let summary = try mapHomeMediaSummary(media.summary, expectedKind: .movie)
    guard summary.identity == selection.identity else {
      throw MovieDetailsResponseMappingError.invalid
    }
    guard !media.hasOriginalTitle || movieDetailsStringIsBounded(media.originalTitle) else {
      throw MovieDetailsResponseMappingError.invalid
    }
    let genres = try mapMovieDetailsStrings(media.genres)
    let studios = try mapMovieDetailsStrings(media.studios)
    let artwork = try media.artwork.compactMap(mapArtworkReference)
    let credits = try media.credits.enumerated().compactMap { index, credit in
      try mapMovieCredit(credit, order: index)
    }
    let sourceSummaries = try media.sourceSummaries.map(mapSourceSummary)
    try validateMoviePlayability(summary, sourceSummaries: sourceSummaries)

    return MovieDetails(
      identity: summary.identity,
      title: summary.title,
      releaseYear: summary.releaseYear,
      runtime: summary.runtime,
      contentRating: summary.contentRating,
      primaryGenre: summary.primaryGenre,
      tagline: try movieDetailsOptionalString(
        media.hasTagline,
        media.tagline,
        maximumLength: MovieDetailsResponseBounds.maximumStringLength,
        allowsEmpty: false
      ),
      synopsis: try movieDetailsOptionalString(
        media.hasSynopsis,
        media.synopsis,
        maximumLength: MovieDetailsResponseBounds.maximumSynopsisLength,
        allowsEmpty: true
      ),
      genres: genres,
      studios: studios,
      credits: credits,
      artwork: artwork,
      playability: summary.playability,
      defaultSource: summary.defaultSource
    )
  }

  private static func validateMovieDetailsShape(
    _ media: Nama_Api_V1_MediaDetails
  ) throws {
    guard
      media.hasSummary,
      case .movie? = media.kindDetails,
      media.genres.count <= MovieDetailsResponseBounds.maximumMetadataItems,
      media.studios.count <= MovieDetailsResponseBounds.maximumMetadataItems,
      media.credits.count <= MovieDetailsResponseBounds.maximumCredits,
      media.artwork.count <= MovieDetailsResponseBounds.maximumArtworkReferences,
      media.sourceSummaries.count <= MovieDetailsResponseBounds.maximumSourceSummaries
    else {
      throw MovieDetailsResponseMappingError.invalid
    }
  }

  private static func mapMovieCredit(
    _ credit: Nama_Api_V1_MediaCredit,
    order: Int
  ) throws -> MovieCredit? {
    guard movieDetailsStringIsBounded(credit.name) else {
      throw MovieDetailsResponseMappingError.invalid
    }
    let role: MovieCreditRole
    switch credit.role {
    case .actor:
      role = .actor

    case .director:
      role = .director

    case .writer:
      role = .writer

    case .UNRECOGNIZED:
      return nil

    case .unspecified:
      throw MovieDetailsResponseMappingError.invalid
    }

    let portraitArtwork: HomeArtworkReference?
    if credit.hasPortraitArtwork {
      portraitArtwork = try mapArtworkReference(credit.portraitArtwork)
      guard portraitArtwork?.role == .portrait else {
        throw MovieDetailsResponseMappingError.invalid
      }
    } else {
      portraitArtwork = nil
    }
    return MovieCredit(
      identity: MovieCreditIdentity(order),
      name: credit.name,
      role: role,
      characterName: try movieDetailsOptionalString(
        credit.hasCharacterName,
        credit.characterName,
        maximumLength: MovieDetailsResponseBounds.maximumStringLength,
        allowsEmpty: false
      ),
      portraitArtwork: portraitArtwork
    )
  }

  private static func mapMovieDetailsStrings(_ values: [String]) throws -> [String] {
    guard values.allSatisfy(movieDetailsStringIsBounded) else {
      throw MovieDetailsResponseMappingError.invalid
    }
    return values
  }

  private static func movieDetailsOptionalString(
    _ isPresent: Bool,
    _ value: String,
    maximumLength: Int,
    allowsEmpty: Bool
  ) throws -> String? {
    guard isPresent else {
      return nil
    }
    guard
      value.unicodeScalars.count <= maximumLength,
      allowsEmpty || !value.isEmpty
    else {
      throw MovieDetailsResponseMappingError.invalid
    }
    return value.isEmpty ? nil : value
  }

  private static func movieDetailsStringIsBounded(_ value: String) -> Bool {
    !value.isEmpty
      && value.unicodeScalars.count <= MovieDetailsResponseBounds.maximumStringLength
  }

  private static func validateMoviePlayability(
    _ summary: HomeMediaSummary,
    sourceSummaries: [HomeSourceSummary]
  ) throws {
    switch summary.playability {
    case .playable:
      guard
        let defaultSource = summary.defaultSource,
        defaultSource.isDefault,
        defaultSource.availability == .available,
        sourceSummaries.contains(where: { source in
          source.identity == defaultSource.identity
            && source.isDefault
            && source.availability == .available
        })
      else {
        throw MovieDetailsResponseMappingError.invalid
      }

    case .temporarilyUnavailable:
      break

    case .noAvailableSource:
      guard summary.defaultSource == nil else {
        throw MovieDetailsResponseMappingError.invalid
      }

    case .unknown:
      throw MovieDetailsResponseMappingError.invalid
    }
  }

  private static func mapMovieDetailsFailure(
    _ error: ConnectError
  ) -> MovieDetailsFailure {
    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    if error.code == .failedPrecondition,
      errorInfo.contains(where: { detail in
        detail.domain == apiErrorDomain && detail.reason == "CLIENT_VERSION_UNSUPPORTED"
      })
    {
      return .incompatible
    }
    if let exception = error.exception {
      return (exception as NSError).domain == NSURLErrorDomain
        ? .transportUnavailable
        : .incompatible
    }

    return switch error.code {
    case .notFound:
      .notFound

    case .canceled, .deadlineExceeded:
      .transportUnavailable

    case .permissionDenied, .unauthenticated:
      .authorizationUnavailable

    case .unimplemented, .invalidArgument, .outOfRange, .ok:
      .incompatible

    case .unknown, .alreadyExists, .resourceExhausted, .failedPrecondition, .aborted,
      .unavailable, .internalError, .dataLoss:
      .namaUnavailable(requestID: requestID(error))
    }
  }
}

nonisolated private enum MovieDetailsResponseBounds {
  static let maximumArtworkReferences = 20
  static let maximumCredits = 100
  static let maximumMetadataItems = 50
  static let maximumSourceSummaries = 100
  static let maximumStringLength = 256
  static let maximumSynopsisLength = 16_384
}

nonisolated private enum MovieDetailsResponseMappingError: Error {
  case invalid
}
