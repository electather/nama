import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient {
  static func mapMediaDetailsResponse(
    _ response: Nama_Api_V1_GetMediaResponse,
    selection: MediaDetailsSelection
  ) throws -> MediaDetails {
    guard response.hasMedia else {
      throw MediaDetailsResponseMappingError.invalid
    }
    let media = response.media
    try validateMediaDetailsShape(media)
    let summary = try mapMediaSummary(media.summary, expectedKind: selection.kind)
    guard
      summary.identity == selection.identity,
      !media.hasOriginalTitle || mediaDetailsStringIsBounded(media.originalTitle)
    else {
      throw MediaDetailsResponseMappingError.invalid
    }
    return try makeMediaDetails(media, summary: summary, selection: selection)
  }

  private static func makeMediaDetails(
    _ media: Nama_Api_V1_MediaDetails,
    summary: MediaSummary,
    selection: MediaDetailsSelection
  ) throws -> MediaDetails {
    let genres = try mapMediaDetailsStrings(media.genres)
    let studios = try mapMediaDetailsStrings(media.studios)
    let artwork = try media.artwork.compactMap(mapArtworkReference)
    var creditOccurrences: [MediaCreditIdentitySeed: Int] = [:]
    let credits = try media.credits.compactMap { credit in
      try mapMediaCredit(credit, occurrences: &creditOccurrences)
    }
    let parents = try mapMediaParents(media.parents, for: selection.kind)
    let sourceSummaries = try media.sourceSummaries.map(mapSourceSummary)
    try validateMediaPlayability(
      summary,
      sourceSummaries: sourceSummaries,
      kind: selection.kind
    )

    return MediaDetails(
      identity: summary.identity,
      title: summary.title,
      releaseYear: summary.releaseYear,
      runtime: summary.runtime,
      contentRating: summary.contentRating,
      primaryGenre: summary.primaryGenre,
      tagline: try mediaDetailsOptionalString(
        media.hasTagline,
        media.tagline,
        maximumLength: MediaDetailsResponseBounds.maximumStringLength,
        allowsEmpty: false
      ),
      synopsis: try mediaDetailsOptionalString(
        media.hasSynopsis,
        media.synopsis,
        maximumLength: MediaDetailsResponseBounds.maximumSynopsisLength,
        allowsEmpty: true
      ),
      genres: genres,
      studios: studios,
      credits: credits,
      artwork: artwork,
      parents: parents,
      playability: summary.playability,
      defaultSource: summary.defaultSource,
      sourceSummaries: sourceSummaries,
      kindDetails: try mapMediaKindDetails(media, summary: summary)
    )
  }

  private static func validateMediaDetailsShape(
    _ media: Nama_Api_V1_MediaDetails
  ) throws {
    guard
      media.hasSummary,
      media.kindDetails != nil,
      media.genres.count <= MediaDetailsResponseBounds.maximumMetadataItems,
      media.studios.count <= MediaDetailsResponseBounds.maximumMetadataItems,
      media.credits.count <= MediaDetailsResponseBounds.maximumCredits,
      media.artwork.count <= MediaDetailsResponseBounds.maximumArtworkReferences,
      media.parents.count <= MediaDetailsResponseBounds.maximumParents,
      media.sourceSummaries.count <= MediaDetailsResponseBounds.maximumSourceSummaries
    else {
      throw MediaDetailsResponseMappingError.invalid
    }
  }

  private static func mapMediaKindDetails(
    _ media: Nama_Api_V1_MediaDetails,
    summary: MediaSummary
  ) throws -> MediaDetailsKind {
    switch media.kindDetails {
    case .movie(let details):
      guard summary.kind == .movie else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return .movie(
        releaseDate: try mapMediaCalendarDate(details.hasReleaseDate, details.releaseDate)
      )

    case .show(let details):
      guard summary.kind == .show else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return .show(
        firstReleaseDate: try mapMediaCalendarDate(
          details.hasFirstReleaseDate,
          details.firstReleaseDate
        ),
        lastReleaseDate: try mapMediaCalendarDate(
          details.hasLastReleaseDate,
          details.lastReleaseDate
        ),
        seasonCount: details.hasSeasonCount ? details.seasonCount : nil,
        episodeCount: details.hasEpisodeCount ? details.episodeCount : nil
      )

    case .season(let details):
      guard summary.kind == .season, details.seasonNumber > 0 else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return .season(
        seasonNumber: details.seasonNumber,
        episodeCount: details.hasEpisodeCount ? details.episodeCount : nil
      )

    case .episode(let details):
      guard
        summary.kind == .episode,
        details.seasonNumber > 0,
        details.episodeNumber > 0,
        summary.episodePosition?.seasonNumber == details.seasonNumber,
        summary.episodePosition?.episodeNumber == details.episodeNumber
      else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return .episode(
        seasonNumber: details.seasonNumber,
        episodeNumber: details.episodeNumber,
        releaseDate: try mapMediaCalendarDate(details.hasReleaseDate, details.releaseDate)
      )

    case nil:
      throw MediaDetailsResponseMappingError.invalid
    }
  }

  private static func mapMediaCalendarDate(
    _ isPresent: Bool,
    _ date: Google_Type_Date
  ) throws -> MediaCalendarDate? {
    guard isPresent else {
      return nil
    }
    guard
      MediaDetailsResponseBounds.validYears.contains(date.year),
      MediaDetailsResponseBounds.validMonths.contains(date.month),
      MediaDetailsResponseBounds.validDays.contains(date.day),
      date.year != 0 || date.month != 0 || date.day != 0,
      date.month != 0 || date.day == 0,
      date.month != 0 || date.year != 0,
      date.year != 0 || date.day != 0,
      date.day == 0 || date.month != 0
    else {
      throw MediaDetailsResponseMappingError.invalid
    }
    if date.day > 0 {
      try validateResolvableMediaDate(date)
    }
    return MediaCalendarDate(
      year: date.year == 0 ? nil : date.year,
      month: date.month == 0 ? nil : date.month,
      day: date.day == 0 ? nil : date.day
    )
  }

  private static func validateResolvableMediaDate(_ date: Google_Type_Date) throws {
    var components = DateComponents()
    components.calendar = Calendar(identifier: .gregorian)
    components.year = Int(
      date.year == 0 ? MediaDetailsResponseBounds.referenceLeapYear : date.year
    )
    components.month = Int(date.month)
    components.day = Int(date.day)
    guard let resolved = components.date else {
      throw MediaDetailsResponseMappingError.invalid
    }
    let resolvedComponents = Calendar(identifier: .gregorian).dateComponents(
      [.year, .month, .day],
      from: resolved
    )
    guard
      resolvedComponents.month == Int(date.month),
      resolvedComponents.day == Int(date.day)
    else {
      throw MediaDetailsResponseMappingError.invalid
    }
  }

  private static func mapMediaParents(
    _ parents: [Nama_Api_V1_MediaParent],
    for kind: MediaKind
  ) throws -> [MediaDetailsParent] {
    let expectedKinds: [MediaKind] =
      switch kind {
      case .movie, .show:
        []

      case .season:
        [.show]

      case .episode:
        [.show, .season]
      }
    guard parents.count == expectedKinds.count else {
      throw MediaDetailsResponseMappingError.invalid
    }

    var seen = Set<MediaIdentity>()
    return try zip(parents, expectedKinds).map { parent, expectedKind in
      guard
        mediaDetailsStringIsBounded(parent.id),
        mediaDetailsStringIsBounded(parent.title),
        try mapMediaKind(parent.kind) == expectedKind
      else {
        throw MediaDetailsResponseMappingError.invalid
      }
      let identity = MediaIdentity(parent.id)
      guard seen.insert(identity).inserted else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return MediaDetailsParent(
        identity: identity,
        kind: expectedKind,
        title: parent.title
      )
    }
  }

  private static func mapMediaCredit(
    _ credit: Nama_Api_V1_MediaCredit,
    occurrences: inout [MediaCreditIdentitySeed: Int]
  ) throws -> MediaCredit? {
    guard mediaDetailsStringIsBounded(credit.name) else {
      throw MediaDetailsResponseMappingError.invalid
    }
    let role: MediaCreditRole
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
      throw MediaDetailsResponseMappingError.invalid
    }

    let characterName = try mediaDetailsOptionalString(
      credit.hasCharacterName,
      credit.characterName,
      maximumLength: MediaDetailsResponseBounds.maximumStringLength,
      allowsEmpty: false
    )
    let seed = MediaCreditIdentitySeed(
      name: credit.name,
      role: role,
      characterName: characterName
    )
    let occurrence = occurrences[seed, default: .zero]
    occurrences[seed] = occurrence + 1
    let portraitArtwork: ArtworkReference?
    if credit.hasPortraitArtwork {
      portraitArtwork = try mapArtworkReference(credit.portraitArtwork)
      guard portraitArtwork?.role == .portrait else {
        throw MediaDetailsResponseMappingError.invalid
      }
    } else {
      portraitArtwork = nil
    }
    return MediaCredit(
      identity: MediaCreditIdentity(
        name: seed.name,
        role: seed.role,
        characterName: seed.characterName,
        occurrence: occurrence
      ),
      name: seed.name,
      role: seed.role,
      characterName: seed.characterName,
      portraitArtwork: portraitArtwork
    )
  }

  private static func mapMediaDetailsStrings(_ values: [String]) throws -> [String] {
    guard values.allSatisfy(mediaDetailsStringIsBounded) else {
      throw MediaDetailsResponseMappingError.invalid
    }
    return values
  }

  private static func mediaDetailsOptionalString(
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
      throw MediaDetailsResponseMappingError.invalid
    }
    return value.isEmpty ? nil : value
  }

  private static func mediaDetailsStringIsBounded(_ value: String) -> Bool {
    !value.isEmpty
      && value.unicodeScalars.count <= MediaDetailsResponseBounds.maximumStringLength
  }

  private static func validateMediaPlayability(
    _ summary: MediaSummary,
    sourceSummaries: [MediaSourceSummary],
    kind: MediaKind
  ) throws {
    guard kind == .movie || kind == .episode else {
      guard
        summary.playability != .playable,
        summary.defaultSource == nil,
        sourceSummaries.isEmpty
      else {
        throw MediaDetailsResponseMappingError.invalid
      }
      return
    }

    switch summary.playability {
    case .playable:
      guard
        let defaultSource = summary.defaultSource,
        defaultSource.isDefault,
        defaultSource.availability == .available,
        sourceSummaries.contains(defaultSource)
      else {
        throw MediaDetailsResponseMappingError.invalid
      }

    case .temporarilyUnavailable:
      break

    case .noAvailableSource:
      guard let defaultSource = summary.defaultSource else {
        break
      }
      guard
        defaultSource.isDefault,
        defaultSource.availability != .available,
        sourceSummaries.contains(defaultSource)
      else {
        throw MediaDetailsResponseMappingError.invalid
      }

    case .unknown:
      throw MediaDetailsResponseMappingError.invalid
    }
  }
}

nonisolated private enum MediaDetailsResponseBounds {
  static let maximumArtworkReferences = 20
  static let maximumCredits = 100
  static let maximumMetadataItems = 50
  static let maximumParents = 3
  static let maximumSourceSummaries = 100
  static let maximumStringLength = 256
  static let maximumSynopsisLength = 16_384
  static let referenceLeapYear: Int32 = 2_000
  static let validDays: ClosedRange<Int32> = 0...31
  static let validMonths: ClosedRange<Int32> = 0...12
  static let validYears: ClosedRange<Int32> = 0...9_999
}

nonisolated private enum MediaDetailsResponseMappingError: Error {
  case invalid
}
