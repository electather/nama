import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient {
  static func mapHomeResponse(
    _ response: Nama_Api_V1_GetHomeResponse
  ) throws -> HomeSnapshot {
    guard response.sections.count <= HomeResponseBounds.maximumSections else {
      throw HomeResponseMappingError.invalid
    }
    var movies: HomeShelf?
    var shows: HomeShelf?

    for section in response.sections {
      switch section.kind {
      case .movies:
        guard movies == nil else {
          throw HomeResponseMappingError.invalid
        }
        movies = try map(section, kind: .movies, itemKind: .movie)

      case .shows:
        guard shows == nil else {
          throw HomeResponseMappingError.invalid
        }
        shows = try map(section, kind: .shows, itemKind: .show)

      case .continueWatching, .UNRECOGNIZED:
        continue

      case .unspecified:
        throw HomeResponseMappingError.invalid
      }
    }

    return HomeSnapshot(movies: movies, shows: shows)
  }

  private static func map(
    _ section: Nama_Api_V1_HomeSection,
    kind: HomeShelfKind,
    itemKind: HomeMediaKind
  ) throws -> HomeShelf? {
    guard
      isBoundedString(section.id),
      isBoundedString(section.title),
      section.items.count <= HomeResponseBounds.maximumSectionItems
    else {
      throw HomeResponseMappingError.invalid
    }
    let items = try section.items.map { item in
      try mapHomeMediaSummary(item, expectedKind: itemKind)
    }
    guard !items.isEmpty else {
      return nil
    }
    return HomeShelf(
      identity: HomeShelfIdentity(section.id),
      title: section.title,
      kind: kind,
      items: items
    )
  }

  static func mapHomeMediaSummary(
    _ summary: Nama_Api_V1_MediaSummary,
    expectedKind: HomeMediaKind
  ) throws -> HomeMediaSummary {
    guard
      isBoundedString(summary.id),
      isBoundedString(summary.title),
      summary.artwork.count <= HomeResponseBounds.maximumArtworkReferences
    else {
      throw HomeResponseMappingError.invalid
    }
    let kind = try map(summary.kind)
    guard kind == expectedKind else {
      throw HomeResponseMappingError.invalid
    }

    let runtime: Duration?
    if summary.hasRuntime {
      guard
        summary.runtime.seconds >= 0,
        summary.runtime.nanos >= 0,
        summary.runtime.nanos < HomeResponseBounds.nanosecondsPerSecond
      else {
        throw HomeResponseMappingError.invalid
      }
      runtime = Duration(
        secondsComponent: summary.runtime.seconds,
        attosecondsComponent: Int64(summary.runtime.nanos)
          * HomeResponseBounds.attosecondsPerNanosecond
      )
    } else {
      runtime = nil
    }

    return HomeMediaSummary(
      identity: HomeMediaIdentity(summary.id),
      kind: kind,
      title: summary.title,
      releaseYear: summary.hasReleaseYear ? summary.releaseYear : nil,
      runtime: runtime,
      contentRating: try optionalString(summary.hasContentRating, summary.contentRating),
      primaryGenre: try optionalString(summary.hasPrimaryGenre, summary.primaryGenre),
      artwork: try summary.artwork.compactMap(Self.mapArtworkReference),
      playability: try map(summary.playability),
      defaultSource: summary.hasDefaultSource ? try mapSourceSummary(summary.defaultSource) : nil
    )
  }

  private static func map(_ kind: Nama_Api_V1_MediaKind) throws -> HomeMediaKind {
    switch kind {
    case .movie:
      .movie

    case .show:
      .show

    case .unspecified, .season, .episode, .UNRECOGNIZED:
      throw HomeResponseMappingError.invalid
    }
  }

  private static func map(
    _ playability: Nama_Api_V1_Playability
  ) throws -> HomePlayability {
    switch playability {
    case .playable:
      .playable

    case .temporarilyUnavailable:
      .temporarilyUnavailable

    case .noAvailableSource:
      .noAvailableSource

    case .UNRECOGNIZED:
      .unknown

    case .unspecified:
      throw HomeResponseMappingError.invalid
    }
  }

  static func mapArtworkReference(
    _ artwork: Nama_Api_V1_ArtworkReference
  ) throws -> HomeArtworkReference? {
    guard
      isBoundedString(artwork.id),
      !artwork.hasWidth || artwork.width > 0,
      !artwork.hasHeight || artwork.height > 0
    else {
      throw HomeResponseMappingError.invalid
    }
    guard let role = try map(artwork.role) else {
      return nil
    }
    let textPresence = try map(artwork.textPresence)

    let locale = try optionalString(artwork.hasLocale, artwork.locale)
    guard locale.map(isValidArtworkLocale) ?? true else {
      throw HomeResponseMappingError.invalid
    }
    return HomeArtworkReference(
      identity: HomeArtworkIdentity(artwork.id),
      role: role,
      width: artwork.hasWidth ? artwork.width : nil,
      height: artwork.hasHeight ? artwork.height : nil,
      locale: locale,
      textPresence: textPresence
    )
  }

  private static func map(
    _ role: Nama_Api_V1_ArtworkRole
  ) throws -> HomeArtworkRole? {
    switch role {
    case .poster:
      .poster

    case .backdrop:
      .backdrop

    case .logo:
      .logo

    case .thumbnail:
      .thumbnail

    case .portrait:
      .portrait

    case .UNRECOGNIZED:
      nil

    case .unspecified:
      throw HomeResponseMappingError.invalid
    }
  }

  private static func map(
    _ textPresence: Nama_Api_V1_ArtworkTextPresence
  ) throws -> HomeArtworkTextPresence {
    switch textPresence {
    case .unknown, .UNRECOGNIZED:
      .unknown

    case .textless:
      .textless

    case .containsText:
      .containsText

    case .unspecified:
      throw HomeResponseMappingError.invalid
    }
  }

  static func mapSourceSummary(
    _ source: Nama_Api_V1_MediaSourceSummary
  ) throws -> HomeSourceSummary {
    guard isBoundedString(source.id) else {
      throw HomeResponseMappingError.invalid
    }

    let availability: HomeSourceAvailability
    switch source.availability {
    case .available:
      availability = .available

    case .providerUnavailable:
      availability = .providerUnavailable

    case .unsupported:
      availability = .unsupported

    case .UNRECOGNIZED:
      availability = .unknown

    case .unspecified:
      throw HomeResponseMappingError.invalid
    }

    return HomeSourceSummary(
      identity: HomeSourceIdentity(source.id),
      label: try optionalString(source.hasLabel, source.label),
      isDefault: source.isDefault,
      availability: availability,
      container: try optionalString(source.hasContainer, source.container),
      videoQuality: source.hasVideoQuality ? try map(source.videoQuality) : nil,
      audioQuality: source.hasAudioQuality ? try map(source.audioQuality) : nil
    )
  }

  private static func map(_ quality: Nama_Api_V1_VideoQuality) throws -> HomeVideoQuality {
    guard
      isBoundedString(quality.codec),
      !quality.hasWidth || quality.width > 0,
      !quality.hasHeight || quality.height > 0
    else {
      throw HomeResponseMappingError.invalid
    }
    let dynamicRange: HomeDynamicRange?
    if quality.hasDynamicRange {
      switch quality.dynamicRange {
      case .sdr:
        dynamicRange = .sdr

      case .hdr10:
        dynamicRange = .hdr10

      case .hdr10Plus:
        dynamicRange = .hdr10Plus

      case .hlg:
        dynamicRange = .hlg

      case .dolbyVision:
        dynamicRange = .dolbyVision

      case .UNRECOGNIZED:
        dynamicRange = .unknown

      case .unspecified:
        throw HomeResponseMappingError.invalid
      }
    } else {
      dynamicRange = nil
    }

    return HomeVideoQuality(
      codec: quality.codec,
      width: quality.hasWidth ? quality.width : nil,
      height: quality.hasHeight ? quality.height : nil,
      dynamicRange: dynamicRange
    )
  }

  private static func map(_ quality: Nama_Api_V1_AudioQuality) throws -> HomeAudioQuality {
    guard
      isBoundedString(quality.codec)
    else {
      throw HomeResponseMappingError.invalid
    }
    let spatialFormat: HomeSpatialAudioFormat?
    if quality.hasSpatialFormat {
      switch quality.spatialFormat {
      case .none:
        spatialFormat = .nonSpatial

      case .dolbyAtmos:
        spatialFormat = .dolbyAtmos

      case .dtsX:
        spatialFormat = .dtsX

      case .UNRECOGNIZED:
        spatialFormat = .unknown

      case .unspecified:
        throw HomeResponseMappingError.invalid
      }
    } else {
      spatialFormat = nil
    }

    return HomeAudioQuality(
      codec: quality.codec,
      channelCount: quality.hasChannelCount ? quality.channelCount : nil,
      spatialFormat: spatialFormat
    )
  }

  private static func isBoundedString(_ value: String) -> Bool {
    !value.isEmpty
      && value.unicodeScalars.count <= HomeResponseBounds.maximumStringLength
  }

  private static func isValidArtworkLocale(_ locale: String) -> Bool {
    let subtags = locale.split(separator: "-", omittingEmptySubsequences: false)
    guard
      let language = subtags.first,
      HomeResponseBounds.languageSubtagLengths.contains(language.unicodeScalars.count),
      language.unicodeScalars.allSatisfy(isASCIILetter)
    else {
      return false
    }
    return subtags.dropFirst().allSatisfy { subtag in
      HomeResponseBounds.localeSubtagLengths.contains(subtag.unicodeScalars.count)
        && subtag.unicodeScalars.allSatisfy { scalar in
          isASCIILetter(scalar) || isASCIIDigit(scalar)
        }
    }
  }

  private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
    (HomeResponseBounds.asciiUppercaseStart...HomeResponseBounds.asciiUppercaseEnd)
      .contains(scalar.value)
      || (HomeResponseBounds.asciiLowercaseStart...HomeResponseBounds.asciiLowercaseEnd)
        .contains(scalar.value)
  }

  private static func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
    (HomeResponseBounds.asciiDigitStart...HomeResponseBounds.asciiDigitEnd)
      .contains(scalar.value)
  }

  private static func optionalString(_ isPresent: Bool, _ value: String) throws -> String? {
    guard isPresent else {
      return nil
    }
    guard isBoundedString(value) else {
      throw HomeResponseMappingError.invalid
    }
    return value
  }
}

nonisolated private enum HomeResponseBounds {
  static let asciiDigitEnd: UInt32 = 57
  static let asciiDigitStart: UInt32 = 48
  static let asciiLowercaseEnd: UInt32 = 122
  static let asciiLowercaseStart: UInt32 = 97
  static let asciiUppercaseEnd: UInt32 = 90
  static let asciiUppercaseStart: UInt32 = 65
  static let attosecondsPerNanosecond: Int64 = 1_000_000_000
  static let languageSubtagLengths = 2...8
  static let localeSubtagLengths = 1...8
  static let nanosecondsPerSecond: Int32 = 1_000_000_000
  static let maximumSections = 3
  static let maximumSectionItems = 50
  static let maximumArtworkReferences = 20
  static let maximumStringLength = 256
}

nonisolated private enum HomeResponseMappingError: Error {
  case invalid
}
