import Foundation

nonisolated enum LibraryKind: String, CaseIterable, Equatable, Hashable, Sendable {
  case movies = "library.movies"
  case shows = "library.shows"

  var mediaKind: MediaKind {
    switch self {
    case .movies:
      .movie

    case .shows:
      .show
    }
  }
}

nonisolated enum LibrarySort: String, CaseIterable, Equatable, Hashable, Sendable {
  case title = "title"
  case releaseDate = "release-date"
  case dateAdded = "date-added"
}

nonisolated struct LibraryQuery: Equatable, Hashable, Sendable {
  let kind: LibraryKind
  let sort: LibrarySort

  static let initial = Self(kind: .movies, sort: .title)
}

typealias LibraryPage = MediaPage
typealias LibrarySnapshot = MediaPageSnapshot<LibraryQuery>

nonisolated enum LibraryLoadingFailure: Error, Equatable, Sendable {
  case catalogNotReady(retryAfterSeconds: Int?)
  case pageTokenInvalid
  case authorizationUnavailable
  case networkUnavailable
  case namaUnavailable(requestID: String?)
  case incompatible
}

nonisolated struct MediaPage: Equatable, Sendable {
  let items: [MediaSummary]
  let nextPageToken: String?
}

nonisolated struct MediaPageSnapshot<Query: Equatable & Sendable>: Equatable, Sendable {
  let query: Query
  let items: [MediaSummary]
  let nextPageToken: String?

  var isTerminal: Bool {
    nextPageToken == nil
  }
}

nonisolated enum MediaPagingState<Query: Equatable & Sendable>: Equatable, Sendable {
  case idle
  case loading
  case catalogNotReady(retryAfterSeconds: Int?)
  case empty(query: Query)
  case content(MediaPageSnapshot<Query>)
  case refreshing(MediaPageSnapshot<Query>)
  case refreshFailed(MediaPageSnapshot<Query>, LibraryLoadingFailure)
  case loadingMore(MediaPageSnapshot<Query>)
  case pageFailed(MediaPageSnapshot<Query>, LibraryLoadingFailure)
  case failed(LibraryLoadingFailure)
}

nonisolated enum LibraryState: Equatable, Sendable {
  case loading
  case catalogNotReady(retryAfterSeconds: Int?)
  case empty
  case content(LibrarySnapshot)
  case refreshing(LibrarySnapshot)
  case refreshFailed(LibrarySnapshot, LibraryLoadingFailure)
  case loadingMore(LibrarySnapshot)
  case pageFailed(LibrarySnapshot, LibraryLoadingFailure)
  case failed(LibraryLoadingFailure)
}

nonisolated protocol LibraryPageLoading: Sendable {
  func loadPage(
    query: LibraryQuery,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibraryPage
}

nonisolated enum LibraryPagePolicy {
  static let size: UInt32 = 50
  static let maximumPageTokenBytes = 4_096
}

enum LibraryArtworkProjection {
  static let collection = MediaArtworkCollectionIdentity("library")

  static func collections(items: [MediaSummary]) -> [MediaArtworkCollection] {
    let projectedCollection = MediaArtworkCollection(
      identity: Self.collection,
      items: items
    )
    return [projectedCollection]
  }
}
