struct LibraryLoadContext {
  let query: LibraryQuery
  let pageToken: String?
  let confirmed: LibrarySnapshot?
  let kind: LibraryLoadKind
  let authorization: HomeAuthorizationIdentity
  let attempt: UInt64
}

enum LibraryLoadKind {
  case initial
  case refresh
  case page
}

func confirmedLibrarySnapshot(_ state: LibraryState) -> LibrarySnapshot? {
  switch state {
  case .content(let snapshot), .refreshing(let snapshot), .refreshFailed(let snapshot, _),
    .loadingMore(let snapshot), .pageFailed(let snapshot, _):
    snapshot

  case .loading, .catalogNotReady, .empty, .failed:
    nil
  }
}

func libraryShouldLoadMore(
  state: LibraryState,
  visibleIdentity: MediaIdentity,
  lookahead: Int
) -> Bool {
  guard
    case .content(let snapshot) = state,
    snapshot.nextPageToken != nil,
    let index = snapshot.items.firstIndex(where: { $0.identity == visibleIdentity })
  else {
    return false
  }
  return snapshot.items.distance(from: index, to: snapshot.items.endIndex) <= lookahead
}

func loadLibraryPage(
  using loader: any LibraryPageLoading,
  context: LibraryLoadContext
) async -> Result<LibraryPage, any Error> {
  do {
    return .success(
      try await loader.loadPage(
        query: context.query,
        pageToken: context.pageToken,
        authorization: context.authorization
      )
    )
  } catch {
    return .failure(error)
  }
}

func libraryFailureState(
  _ failure: LibraryLoadingFailure,
  context: LibraryLoadContext
) -> LibraryState {
  if let confirmed = context.confirmed {
    return context.kind == .refresh
      ? .refreshFailed(confirmed, failure)
      : .pageFailed(confirmed, failure)
  }
  return switch failure {
  case .catalogNotReady(let retryAfterSeconds):
    .catalogNotReady(retryAfterSeconds: retryAfterSeconds)

  case .pageTokenInvalid, .authorizationUnavailable, .networkUnavailable, .namaUnavailable,
    .incompatible:
    .failed(failure)
  }
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
