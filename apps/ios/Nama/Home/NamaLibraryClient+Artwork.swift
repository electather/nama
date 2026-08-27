import Foundation
import NamaAPI
import SwiftProtobuf

nonisolated extension NamaLibraryClient: HomeArtworkResolving {
  private static let minimumTimestampSeconds: Int64 = -62_135_596_800
  private static let maximumTimestampSeconds: Int64 = 253_402_300_799
  private static let nanosecondsPerSecond: Int32 = 1_000_000_000

  func resolve(
    _ reference: HomeArtworkReference,
    size: HomeArtworkSizeBucket,
    authorization: HomeAuthorizationIdentity
  ) async throws -> HomeArtworkResolvedLocator {
    let snapshot = await tokenStore.load()
    guard !Task.isCancelled else {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw HomeArtworkResolutionError.unavailable
    }
    var request = Nama_Api_V1_ResolveArtworkRequest()
    request.artworkID = reference.identity.rawValue
    request.maxWidth = size.maxWidth
    request.maxHeight = size.maxHeight
    let response = await libraryClient(using: record).resolveArtwork(request: request)
    guard !Task.isCancelled else {
      throw CancellationError()
    }
    guard case .success(let message) = response.result, message.hasLocator else {
      throw HomeArtworkResolutionError.unavailable
    }
    let locator = message.locator
    guard
      locator.hasRefreshAt,
      let refreshAt = Self.date(locator.refreshAt),
      let accessExpiresAt = try Self.optionalDate(
        isPresent: locator.hasAccessExpiresAt,
        timestamp: locator.accessExpiresAt
      )
    else {
      throw HomeArtworkResolutionError.invalid
    }
    return HomeArtworkResolvedLocator(
      url: locator.url,
      headers: locator.headers.map { header in
        HomeArtworkHeader(name: header.name, value: header.value)
      },
      allowedRedirectOrigins: locator.allowedRedirectOrigins,
      refreshAt: refreshAt,
      accessExpiresAt: accessExpiresAt,
      width: locator.hasWidth ? locator.width : nil,
      height: locator.hasHeight ? locator.height : nil
    )
  }

  private static func optionalDate(
    isPresent: Bool,
    timestamp: Google_Protobuf_Timestamp
  ) throws -> Date? {
    guard isPresent else {
      return nil
    }
    guard let convertedDate = date(timestamp) else {
      throw HomeArtworkResolutionError.invalid
    }
    return convertedDate
  }

  private static func date(_ timestamp: Google_Protobuf_Timestamp) -> Date? {
    guard
      (minimumTimestampSeconds...maximumTimestampSeconds).contains(timestamp.seconds),
      (.zero..<nanosecondsPerSecond).contains(timestamp.nanos)
    else {
      return nil
    }
    return Date(
      timeIntervalSince1970: TimeInterval(timestamp.seconds)
        + TimeInterval(timestamp.nanos) / TimeInterval(nanosecondsPerSecond)
    )
  }
}

nonisolated private enum HomeArtworkResolutionError: Error {
  case unavailable
  case invalid
}
