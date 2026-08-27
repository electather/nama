import Connect
import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient: MediaDetailsLoading, MediaChildrenLoading {
  func load(
    _ selection: MediaDetailsSelection,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaDetails {
    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw MediaDetailsFailure.authorizationUnavailable
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
        return try Self.mapMediaDetailsResponse(value, selection: selection)
      } catch {
        throw MediaDetailsFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapMediaDetailsFailure(error)
    }
  }

  func loadChildren(
    for parent: MediaDetailsSelection,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaChildrenPage {
    let expectedKind: MediaKind
    switch parent.kind {
    case .show:
      expectedKind = .season

    case .season:
      expectedKind = .episode

    case .movie, .episode, nil:
      throw MediaDetailsFailure.incompatible
    }

    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw MediaDetailsFailure.authorizationUnavailable
    }

    var request = Nama_Api_V1_ListChildrenRequest()
    request.parentMediaID = parent.identity.rawValue
    request.pageSize = MediaChildrenPagePolicy.size
    request.pageToken = pageToken ?? ""
    let response = await libraryClient(using: record).listChildren(request: request)
    if Task.isCancelled {
      throw CancellationError()
    }
    switch response.result {
    case .success(let value):
      do {
        return try Self.mapMediaChildrenResponse(value, expectedKind: expectedKind)
      } catch {
        throw MediaDetailsFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapMediaDetailsFailure(error)
    }
  }

  private static func mapMediaDetailsFailure(
    _ error: ConnectError
  ) -> MediaDetailsFailure {
    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    if isCatalogNotReady(error) {
      return .catalogNotReady(retryAfterSeconds: retryDelaySeconds(error))
    }
    if error.code == .invalidArgument,
      errorInfo.contains(where: { detail in
        detail.domain == apiErrorDomain && detail.reason == "PAGE_TOKEN_INVALID"
      })
    {
      return .pageTokenInvalid
    }
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
      .namaUnavailable(
        requestID: requestID(error),
        retryAfterSeconds: retryDelaySeconds(error)
      )
    }
  }
}
