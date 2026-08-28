import Foundation

nonisolated struct LibrarySearchPage: Equatable, Sendable {
  let items: [MediaSummary]
  let nextPageToken: String?
}

nonisolated struct LibrarySearchSnapshot: Equatable, Sendable {
  let query: String
  let items: [MediaSummary]
  let nextPageToken: String?

  var isTerminal: Bool {
    nextPageToken == nil
  }
}

nonisolated enum LibrarySearchState: Equatable, Sendable {
  case idle
  case loading
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

nonisolated struct LibrarySearchNoResultsPresentation: Equatable, Sendable {
  let title: String
  let description: String
  let actionTitle: String
}

nonisolated func librarySearchNoResultsPresentation(
  query: String
) -> LibrarySearchNoResultsPresentation {
  LibrarySearchNoResultsPresentation(
    title: "No results",
    description: "No stored media matches “\(query)”.",
    actionTitle: "Clear Search"
  )
}

nonisolated enum LibrarySearchPolicy {
  private static let debounceMilliseconds = 300
  static let debounce = Duration.milliseconds(debounceMilliseconds)
}
