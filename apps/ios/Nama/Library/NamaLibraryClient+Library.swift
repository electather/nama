import Connect
import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient: LibraryPageLoading {
  func loadPage(
    query: LibraryQuery,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibraryPage {
    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw LibraryLoadingFailure.authorizationUnavailable
    }

    var request = Nama_Api_V1_ListLibraryRequest()
    request.filter.kinds = [Self.requestKind(query.kind)]
    request.filter.watchFilter = .any
    request.sort = Self.requestSort(query.sort)
    request.pageSize = LibraryPagePolicy.size
    request.pageToken = pageToken ?? ""
    let response = await libraryClient(using: record).listLibrary(request: request)
    if Task.isCancelled {
      throw CancellationError()
    }
    switch response.result {
    case .success(let value):
      do {
        guard
          value.items.count <= Int(LibraryPagePolicy.size),
          value.nextPageToken.utf8.count <= LibraryPagePolicy.maximumPageTokenBytes
        else {
          throw LibraryLoadingFailure.incompatible
        }
        return LibraryPage(
          items: try value.items.map { item in
            try Self.mapMediaSummary(item, expectedKind: query.kind.mediaKind)
          },
          nextPageToken: value.nextPageToken.isEmpty ? nil : value.nextPageToken
        )
      } catch {
        throw LibraryLoadingFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapLibraryFailure(error)
    }
  }

  private static func requestKind(_ kind: LibraryKind) -> Nama_Api_V1_MediaKind {
    switch kind {
    case .movies:
      .movie

    case .shows:
      .show
    }
  }

  private static func requestSort(_ sort: LibrarySort) -> Nama_Api_V1_LibrarySort {
    switch sort {
    case .title:
      .titleAsc

    case .releaseDate:
      .releaseDateDesc

    case .dateAdded:
      .dateAddedDesc
    }
  }

  static func mapLibraryFailure(_ error: ConnectError) -> LibraryLoadingFailure {
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
        ? .networkUnavailable
        : .incompatible
    }

    return switch error.code {
    case .canceled, .deadlineExceeded:
      .networkUnavailable

    case .permissionDenied, .unauthenticated:
      .authorizationUnavailable

    case .resourceExhausted, .unavailable:
      .namaUnavailable(requestID: requestID(error))

    case .ok, .unknown, .invalidArgument, .notFound, .alreadyExists, .failedPrecondition,
      .aborted, .outOfRange, .unimplemented, .internalError, .dataLoss:
      .incompatible
    }
  }
}
