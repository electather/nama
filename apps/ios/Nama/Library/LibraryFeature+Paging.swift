extension LibraryFeature {
  var confirmedSnapshot: LibrarySnapshot? {
    confirmedLibrarySnapshot(state)
  }

  func updateQuery(_ newQuery: LibraryQuery) {
    guard query != newQuery else {
      return
    }
    query = newQuery
    artworkWindow.collectionsDidChange(LibraryArtworkProjection.collections(items: []))
    guard authorization != nil else {
      state = .loading
      return
    }
    startFirstPage(preserving: nil)
  }

  func startFirstPage(preserving snapshot: LibrarySnapshot?) {
    guard let currentAuthorization = authorization else {
      return
    }
    resetPageRecovery()
    continuationTracker.begin(
      currentPageToken: nil,
      continuationAllowance: Int(LibraryPagePolicy.size)
    )
    startLoad(
      pageToken: nil,
      confirmed: snapshot,
      kind: snapshot == nil ? .initial : .refresh,
      authorization: currentAuthorization
    )
    state = snapshot.map(LibraryState.refreshing) ?? .loading
  }

  func startPage(
    from snapshot: LibrarySnapshot,
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
      pageToken: pageToken,
      confirmed: snapshot,
      kind: .page,
      authorization: currentAuthorization
    )
    state = .loadingMore(snapshot)
  }

  func startExpiredPageRecovery(from snapshot: LibrarySnapshot) {
    guard authorization != nil else {
      return
    }
    resetPageRecovery()
    recoveryVisibleSnapshot = snapshot
    recoverySnapshot = LibrarySnapshot(
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

  private func startLoad(
    pageToken: String?,
    confirmed: LibrarySnapshot?,
    kind: LibraryLoadKind,
    authorization currentAuthorization: HomeAuthorizationIdentity
  ) {
    cancelActiveLoad()
    attempt &+= 1
    let context = LibraryLoadContext(
      query: query,
      pageToken: pageToken,
      confirmed: confirmed,
      kind: kind,
      authorization: currentAuthorization,
      attempt: attempt
    )
    let currentLoader = loader
    activeTask = Task { [weak self] in
      let result = await loadLibraryPage(
        using: currentLoader,
        context: context
      )
      guard !Task.isCancelled else {
        return
      }
      self?.finish(result, context: context)
    }
  }

  private func finish(
    _ result: Result<LibraryPage, any Error>,
    context: LibraryLoadContext
  ) {
    guard
      authorization == context.authorization,
      query == context.query,
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
      state = libraryFailureState(
        (error as? LibraryLoadingFailure) ?? .incompatible,
        context: context
      )
    }
  }

  private func publish(_ page: LibraryPage, context: LibraryLoadContext) {
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
        ? .empty
        : .content(projection.snapshot)
      artworkWindow.collectionsDidChange(
        LibraryArtworkProjection.collections(items: projection.snapshot.items)
      )

    case .loadNext:
      if recoverySnapshot != nil {
        recoverySnapshot = projection.snapshot
        startRecoveryPage()
      } else {
        artworkWindow.collectionsDidChange(
          LibraryArtworkProjection.collections(items: projection.snapshot.items)
        )
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
    _ page: LibraryPage,
    context: LibraryLoadContext
  ) -> (snapshot: LibrarySnapshot, pageAddedIdentities: Bool) {
    let baseSnapshot: LibrarySnapshot
    if let recoverySnapshot {
      baseSnapshot = recoverySnapshot
    } else if context.kind == .page, let confirmed = context.confirmed {
      baseSnapshot = confirmed
    } else {
      baseSnapshot = LibrarySnapshot(
        query: context.query,
        items: [],
        nextPageToken: nil
      )
    }
    let items = appendingUniqueMediaSummaries(baseSnapshot.items, page.items)
    let snapshot = LibrarySnapshot(
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
      pageToken: recoverySnapshot.nextPageToken,
      confirmed: recoveryVisibleSnapshot,
      kind: .page,
      authorization: currentAuthorization
    )
    state = .loadingMore(recoveryVisibleSnapshot)
  }
}
