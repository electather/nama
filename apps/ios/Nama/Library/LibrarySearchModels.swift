import Foundation

typealias LibrarySearchPage = MediaPage
typealias LibrarySearchSnapshot = MediaPageSnapshot<String>

nonisolated enum LibrarySearchState: Equatable, Sendable {
  case idle
  case loading
  case catalogNotReady(retryAfterSeconds: Int?)
  case noResults(query: String)
  case content(LibrarySearchSnapshot)
  case refreshing(LibrarySearchSnapshot)
  case refreshFailed(LibrarySearchSnapshot, LibraryLoadingFailure)
  case loadingMore(LibrarySearchSnapshot)
  case pageFailed(LibrarySearchSnapshot, LibraryLoadingFailure)
  case failed(LibraryLoadingFailure)
}

nonisolated protocol LibrarySearchPageLoading: Sendable {
  func loadSearchPage(
    query: String,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibrarySearchPage
}

nonisolated enum LibrarySearchPolicy {
  private static let debounceMilliseconds = 300
  static let debounce = Duration.milliseconds(debounceMilliseconds)
}
