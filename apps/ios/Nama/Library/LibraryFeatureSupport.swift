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

enum LibraryPageRecoveryAction {
  case finished
  case loadMore
  case incompatible
}

struct LibraryPageRecovery {
  private var isActive = false
  private var tokens = Set<String>()
  private var remainingContinuations = 0

  mutating func begin(confirmedItemCount: Int) {
    isActive = true
    tokens.removeAll(keepingCapacity: true)
    remainingContinuations = confirmedItemCount
  }

  mutating func action(
    confirmedItemCount: Int,
    snapshot: LibrarySnapshot,
    requestedPageToken: String?
  ) -> LibraryPageRecoveryAction {
    if !isActive,
      requestedPageToken != nil,
      snapshot.items.count == confirmedItemCount,
      snapshot.nextPageToken != nil
    {
      begin(confirmedItemCount: snapshot.items.count)
    }
    guard isActive else {
      return .finished
    }
    guard snapshot.items.count == confirmedItemCount else {
      reset()
      return .finished
    }
    guard let nextPageToken = snapshot.nextPageToken else {
      reset()
      return .finished
    }
    guard
      remainingContinuations > 0,
      tokens.insert(nextPageToken).inserted
    else {
      reset()
      return .incompatible
    }
    remainingContinuations -= 1
    return .loadMore
  }

  mutating func reset() {
    isActive = false
    tokens.removeAll(keepingCapacity: true)
    remainingContinuations = 0
  }
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

func appendingUniqueLibraryItems(
  _ confirmed: [MediaSummary],
  _ candidates: [MediaSummary]
) -> [MediaSummary] {
  var identities = Set(confirmed.map(\.identity))
  return confirmed
    + candidates.filter { item in
      identities.insert(item.identity).inserted
    }
}
