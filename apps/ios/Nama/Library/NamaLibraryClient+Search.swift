import Connect
import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient: LibrarySearchPageLoading {
  func loadSearchPage(
    query: String,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibrarySearchPage {
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

    var request = Nama_Api_V1_SearchRequest()
    request.query = query
    request.kinds = [.movie, .show, .season, .episode]
    request.pageSize = LibraryPagePolicy.size
    request.pageToken = pageToken ?? ""
    let response = await libraryClient(using: record).search(request: request)
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
        return LibrarySearchPage(
          items: try value.items.map { item in
            try Self.mapMediaSummary(item, expectedKind: nil)
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
}
