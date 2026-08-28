import Foundation

private struct LibrarySearchLoadRequest {
  let query: String
  let pageToken: String?
  let confirmed: LibrarySearchSnapshot?
  let kind: LibraryLoadKind
  let authorization: HomeAuthorizationIdentity
  let debounced: Bool
}

private struct LibrarySearchLoadContext {
  let query: String
  let pageToken: String?
  let confirmed: LibrarySearchSnapshot?
  let kind: LibraryLoadKind
  let authorization: HomeAuthorizationIdentity
  let attempt: UInt64

  init(request: LibrarySearchLoadRequest, attempt: UInt64) {
    query = request.query
    pageToken = request.pageToken
    confirmed = request.confirmed
    kind = request.kind
    authorization = request.authorization
    self.attempt = attempt
  }
}

extension LibrarySearchFeature {
  var normalizedQuery: String? {
    let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return query.isEmpty ? nil : query
  }

  var confirmedSnapshot: LibrarySearchSnapshot? {
    confirmedLibrarySearchSnapshot(state)
  }

  func searchTextDidChange() {
    resetPageRecovery()
    artworkWindow.collectionsDidChange([])
    guard let query = normalizedQuery, let currentAuthorization = authorization else {
      cancelActiveLoad()
      state = .idle
      return
    }
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: Int(LibraryPagePolicy.size)
    )
    startLoad(
      LibrarySearchLoadRequest(
        query: query,
        pageToken: nil,
        confirmed: nil,
        kind: .initial,
        authorization: currentAuthorization,
        debounced: true
      )
    )
    state = .loading
  }

  func startFirstPage(
    preserving snapshot: LibrarySearchSnapshot?,
    debounced: Bool
  ) {
    guard let query = normalizedQuery, let currentAuthorization = authorization else {
      return
    }
    resetPageRecovery()
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: Int(LibraryPagePolicy.size)
    )
    startLoad(
      LibrarySearchLoadRequest(
        query: query,
        pageToken: nil,
        confirmed: snapshot,
        kind: snapshot == nil ? .initial : .refresh,
        authorization: currentAuthorization,
        debounced: debounced
      )
    )
    state = snapshot.map(LibrarySearchState.refreshing) ?? .loading
  }

  func startPage(
    from snapshot: LibrarySearchSnapshot,
    continuingRecovery: Bool = false
  ) {
    guard
      let currentAuthorization = authorization,
      let pageToken = snapshot.nextPageToken
    else {
      return
    }
    if !continuingRecovery {
      resetPageRecovery()
      continuationTracker.begin(
        currentPageToken: pageToken,
        continuationAllowance: snapshot.items.count
      )
    }
    startLoad(
      LibrarySearchLoadRequest(
        query: snapshot.query,
        pageToken: pageToken,
        confirmed: snapshot,
        kind: .page,
        authorization: currentAuthorization,
        debounced: false
      )
    )
    state = .loadingMore(snapshot)
  }

  func startExpiredPageRecovery(from snapshot: LibrarySearchSnapshot) {
    guard authorization != nil else {
      return
    }
    resetPageRecovery()
    recoveryVisibleSnapshot = snapshot
    recoverySnapshot = LibrarySearchSnapshot(
      query: snapshot.query,
      items: [],
      nextPageToken: nil
    )
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: snapshot.items.count
    )
    startRecoveryPage()
  }

  func resetPageRecovery() {
    continuationTracker.reset()
    recoverySnapshot = nil
    recoveryVisibleSnapshot = nil
  }

  func cancelActiveLoad() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }

  private func startLoad(_ request: LibrarySearchLoadRequest) {
    cancelActiveLoad()
    attempt &+= 1
    let context = LibrarySearchLoadContext(request: request, attempt: attempt)
    let currentLoader = loader
    let currentSleep = sleep
    activeTask = Task { [weak self] in
      if request.debounced {
        do {
          try await currentSleep(LibrarySearchPolicy.debounce)
        } catch {
          return
        }
      }
      guard !Task.isCancelled else {
        return
      }
      let result = await loadLibrarySearchPage(using: currentLoader, context: context)
      guard !Task.isCancelled else {
        return
      }
      self?.finish(result, context: context)
    }
  }

  private func finish(
    _ result: Result<LibrarySearchPage, any Error>,
    context: LibrarySearchLoadContext
  ) {
    guard
      authorization == context.authorization,
      normalizedQuery == context.query,
      attempt == context.attempt
    else {
      return
    }
    activeTask = nil
    switch result {
    case .success(let page):
      publish(page, context: context)

    case .failure(is CancellationError):
      return

    case .failure(let error):
      state = librarySearchFailureState(
        (error as? LibraryLoadingFailure) ?? .incompatible,
        context: context
      )
    }
  }

  private func publish(
    _ page: LibrarySearchPage,
    context: LibrarySearchLoadContext
  ) {
    let projection = pageProjection(page, context: context)
    switch continuationTracker.transition(
      pageAddedIdentities: projection.pageAddedIdentities,
      nextPageToken: page.nextPageToken
    ) {
    case .finished:
      recoverySnapshot = nil
      recoveryVisibleSnapshot = nil
      state =
        projection.snapshot.items.isEmpty
        ? .noResults(query: projection.snapshot.query)
        : .content(projection.snapshot)
      publishArtwork(for: projection.snapshot.items)

    case .loadNext:
      if recoverySnapshot != nil {
        recoverySnapshot = projection.snapshot
        startRecoveryPage()
      } else {
        publishArtwork(for: projection.snapshot.items)
        startPage(from: projection.snapshot, continuingRecovery: true)
      }

    case .incompatible:
      if let recoveryVisibleSnapshot {
        state = .pageFailed(recoveryVisibleSnapshot, .incompatible)
      } else {
        state = .pageFailed(projection.snapshot, .incompatible)
        recoverySnapshot = nil
        recoveryVisibleSnapshot = nil
      }
    }
  }

  private func pageProjection(
    _ page: LibrarySearchPage,
    context: LibrarySearchLoadContext
  ) -> (snapshot: LibrarySearchSnapshot, pageAddedIdentities: Bool) {
    let baseSnapshot: LibrarySearchSnapshot
    if let recoverySnapshot {
      baseSnapshot = recoverySnapshot
    } else if context.kind == .page, let confirmed = context.confirmed {
      baseSnapshot = confirmed
    } else {
      baseSnapshot = LibrarySearchSnapshot(
        query: context.query,
        items: [],
        nextPageToken: nil
      )
    }
    let items = appendingUniqueMediaSummaries(baseSnapshot.items, page.items)
    let snapshot = LibrarySearchSnapshot(
      query: context.query,
      items: items,
      nextPageToken: page.nextPageToken
    )
    let pageAddedIdentities: Bool
    if let recoveryVisibleSnapshot {
      let knownItems = appendingUniqueMediaSummaries(
        recoveryVisibleSnapshot.items,
        baseSnapshot.items
      )
      pageAddedIdentities =
        appendingUniqueMediaSummaries(knownItems, page.items).count > knownItems.count
    } else {
      pageAddedIdentities = items.count > baseSnapshot.items.count
    }
    return (snapshot, pageAddedIdentities)
  }

  func startRecoveryPage() {
    guard
      let currentAuthorization = authorization,
      let recoverySnapshot,
      let recoveryVisibleSnapshot
    else {
      return
    }
    startLoad(
      LibrarySearchLoadRequest(
        query: recoverySnapshot.query,
        pageToken: recoverySnapshot.nextPageToken,
        confirmed: recoveryVisibleSnapshot,
        kind: .page,
        authorization: currentAuthorization,
        debounced: false
      )
    )
    state = .loadingMore(recoveryVisibleSnapshot)
  }

  private func publishArtwork(for items: [MediaSummary]) {
    let collection = MediaArtworkCollection(
      identity: Self.artworkCollection,
      items: items,
      preference: .search
    )
    artworkWindow.collectionsDidChange([collection])
  }
}

private func confirmedLibrarySearchSnapshot(
  _ state: LibrarySearchState
) -> LibrarySearchSnapshot? {
  switch state {
  case .content(let snapshot), .refreshing(let snapshot), .refreshFailed(let snapshot, _),
    .loadingMore(let snapshot), .pageFailed(let snapshot, _):
    snapshot

  case .idle, .loading, .noResults, .failed:
    nil
  }
}

func librarySearchShouldLoadMore(
  state: LibrarySearchState,
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

private func loadLibrarySearchPage(
  using loader: any LibrarySearchPageLoading,
  context: LibrarySearchLoadContext
) async -> Result<LibrarySearchPage, any Error> {
  do {
    return .success(
      try await loader.loadSearchPage(
        query: context.query,
        pageToken: context.pageToken,
        authorization: context.authorization
      )
    )
  } catch {
    return .failure(error)
  }
}

private func librarySearchFailureState(
  _ failure: LibraryLoadingFailure,
  context: LibrarySearchLoadContext
) -> LibrarySearchState {
  if let confirmed = context.confirmed {
    return context.kind == .refresh
      ? .refreshFailed(confirmed, failure)
      : .pageFailed(confirmed, failure)
  }
  return .failed(failure)
}
