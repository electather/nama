import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient {
  static func mapMediaSummary(
    _ summary: Nama_Api_V1_MediaSummary,
    expectedKind: MediaKind
  ) throws -> MediaSummary {
    guard
      mediaStringIsBounded(summary.id),
      mediaStringIsBounded(summary.title),
      summary.artwork.count <= MediaResponseBounds.maximumArtworkReferences
    else {
      throw MediaResponseMappingError.invalid
    }
    let kind = try map(summary.kind)
    guard kind == expectedKind else {
      throw MediaResponseMappingError.invalid
    }

    let runtime: Duration?
    if summary.hasRuntime {
      guard
        summary.runtime.seconds >= 0,
        summary.runtime.nanos >= 0,
        summary.runtime.nanos < MediaResponseBounds.nanosecondsPerSecond
      else {
        throw MediaResponseMappingError.invalid
      }
      runtime = Duration(
        secondsComponent: summary.runtime.seconds,
        attosecondsComponent: Int64(summary.runtime.nanos)
          * MediaResponseBounds.attosecondsPerNanosecond
      )
    } else {
      runtime = nil
    }

    return MediaSummary(
      identity: MediaIdentity(summary.id),
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

  private static func map(_ kind: Nama_Api_V1_MediaKind) throws -> MediaKind {
    switch kind {
    case .movie:
      .movie

    case .show:
      .show

    case .unspecified, .season, .episode, .UNRECOGNIZED:
      throw MediaResponseMappingError.invalid
    }
  }

  private static func map(
    _ playability: Nama_Api_V1_Playability
  ) throws -> MediaPlayability {
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
      throw MediaResponseMappingError.invalid
    }
  }

  static func mapArtworkReference(
    _ artwork: Nama_Api_V1_ArtworkReference
  ) throws -> ArtworkReference? {
    guard
      mediaStringIsBounded(artwork.id),
      !artwork.hasWidth || artwork.width > 0,
      !artwork.hasHeight || artwork.height > 0
    else {
      throw MediaResponseMappingError.invalid
    }
    guard let role = try map(artwork.role) else {
      return nil
    }
    let textPresence = try map(artwork.textPresence)

    let locale = try optionalString(artwork.hasLocale, artwork.locale)
    guard locale.map(isValidArtworkLocale) ?? true else {
      throw MediaResponseMappingError.invalid
    }
    return ArtworkReference(
      identity: ArtworkIdentity(artwork.id),
      role: role,
      width: artwork.hasWidth ? artwork.width : nil,
      height: artwork.hasHeight ? artwork.height : nil,
      locale: locale,
      textPresence: textPresence
    )
  }

  private static func map(
    _ role: Nama_Api_V1_ArtworkRole
  ) throws -> ArtworkRole? {
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
      throw MediaResponseMappingError.invalid
    }
  }

  private static func map(
    _ textPresence: Nama_Api_V1_ArtworkTextPresence
  ) throws -> ArtworkTextPresence {
    switch textPresence {
    case .unknown, .UNRECOGNIZED:
      .unknown

    case .textless:
      .textless

    case .containsText:
      .containsText

    case .unspecified:
      throw MediaResponseMappingError.invalid
    }
  }

  static func mapSourceSummary(
    _ source: Nama_Api_V1_MediaSourceSummary
  ) throws -> MediaSourceSummary {
    guard mediaStringIsBounded(source.id) else {
      throw MediaResponseMappingError.invalid
    }

    let availability: MediaSourceAvailability
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
      throw MediaResponseMappingError.invalid
    }

    return MediaSourceSummary(
      identity: MediaSourceIdentity(source.id),
      label: try optionalString(source.hasLabel, source.label),
      isDefault: source.isDefault,
      availability: availability,
      container: try optionalString(source.hasContainer, source.container),
      videoQuality: source.hasVideoQuality ? try map(source.videoQuality) : nil,
      audioQuality: source.hasAudioQuality ? try map(source.audioQuality) : nil
    )
  }

  private static func map(_ quality: Nama_Api_V1_VideoQuality) throws -> MediaVideoQuality {
    guard
      mediaStringIsBounded(quality.codec),
      !quality.hasWidth || quality.width > 0,
      !quality.hasHeight || quality.height > 0
    else {
      throw MediaResponseMappingError.invalid
    }
    let dynamicRange: MediaDynamicRange?
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
        throw MediaResponseMappingError.invalid
      }
    } else {
      dynamicRange = nil
    }

    return MediaVideoQuality(
      codec: quality.codec,
      width: quality.hasWidth ? quality.width : nil,
      height: quality.hasHeight ? quality.height : nil,
      dynamicRange: dynamicRange
    )
  }

  private static func map(_ quality: Nama_Api_V1_AudioQuality) throws -> MediaAudioQuality {
    guard mediaStringIsBounded(quality.codec) else {
      throw MediaResponseMappingError.invalid
    }
    let spatialFormat: MediaSpatialAudioFormat?
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
        throw MediaResponseMappingError.invalid
      }
    } else {
      spatialFormat = nil
    }

    return MediaAudioQuality(
      codec: quality.codec,
      channelCount: quality.hasChannelCount ? quality.channelCount : nil,
      spatialFormat: spatialFormat
    )
  }

  static func mediaStringIsBounded(_ value: String) -> Bool {
    !value.isEmpty
      && value.unicodeScalars.count <= MediaResponseBounds.maximumStringLength
  }

  private static func isValidArtworkLocale(_ locale: String) -> Bool {
    let subtags = locale.split(separator: "-", omittingEmptySubsequences: false)
    guard
      let language = subtags.first,
      MediaResponseBounds.languageSubtagLengths.contains(language.unicodeScalars.count),
      language.unicodeScalars.allSatisfy(isASCIILetter)
    else {
      return false
    }
    return subtags.dropFirst().allSatisfy { subtag in
      MediaResponseBounds.localeSubtagLengths.contains(subtag.unicodeScalars.count)
        && subtag.unicodeScalars.allSatisfy { scalar in
          isASCIILetter(scalar) || isASCIIDigit(scalar)
        }
    }
  }

  private static func isASCIILetter(_ scalar: Unicode.Scalar) -> Bool {
    (MediaResponseBounds.asciiUppercaseStart...MediaResponseBounds.asciiUppercaseEnd)
      .contains(scalar.value)
      || (MediaResponseBounds.asciiLowercaseStart...MediaResponseBounds.asciiLowercaseEnd)
        .contains(scalar.value)
  }

  private static func isASCIIDigit(_ scalar: Unicode.Scalar) -> Bool {
    (MediaResponseBounds.asciiDigitStart...MediaResponseBounds.asciiDigitEnd)
      .contains(scalar.value)
  }

  private static func optionalString(_ isPresent: Bool, _ value: String) throws -> String? {
    guard isPresent else {
      return nil
    }
    guard mediaStringIsBounded(value) else {
      throw MediaResponseMappingError.invalid
    }
    return value
  }
}

nonisolated private enum MediaResponseBounds {
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
  static let maximumArtworkReferences = 20
  static let maximumStringLength = 256
}

nonisolated enum MediaResponseMappingError: Error {
  case invalid
}
