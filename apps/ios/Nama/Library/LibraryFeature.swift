import Observation

@MainActor
@Observable
final class LibraryFeature {
  private static let pageLookahead = 2

  private(set) var query: LibraryQuery = .initial
  private(set) var state: LibraryState = .loading

  @ObservationIgnored private let loader: any LibraryPageLoading
  @ObservationIgnored let artworkWindow: MediaArtworkWindow
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = .zero
  @ObservationIgnored private var pageRecovery = LibraryPageRecovery()

  init(loader: any LibraryPageLoading, artworkLoader: any HomeArtworkLoading) {
    self.loader = loader
    artworkWindow = MediaArtworkWindow(loader: artworkLoader)
  }

  deinit {
    activeTask?.cancel()
  }

  func activate(_ newAuthorization: HomeAuthorizationIdentity) {
    guard authorization != newAuthorization else {
      return
    }
    authorization = newAuthorization
    artworkWindow.authorizationDidChange(to: newAuthorization)
    startFirstPage(preserving: nil)
  }

  func updateKind(_ kind: LibraryKind) {
    updateQuery(LibraryQuery(kind: kind, sort: query.sort))
  }

  func updateSort(_ sort: LibrarySort) {
    updateQuery(LibraryQuery(kind: query.kind, sort: sort))
  }

  func refresh() {
    guard authorization != nil else {
      return
    }
    startFirstPage(preserving: confirmedSnapshot)
  }

  func retry() {
    guard authorization != nil else {
      return
    }
    startFirstPage(preserving: nil)
  }

  func loadMore() {
    guard
      activeTask == nil,
      let snapshot = confirmedSnapshot,
      snapshot.query == query,
      snapshot.nextPageToken != nil
    else {
      return
    }
    startPage(from: snapshot)
  }

  func retryPage() {
    guard case .pageFailed(let snapshot, let failure) = state else {
      return
    }
    if failure == .pageTokenInvalid {
      startExpiredPageRecovery(from: snapshot)
    } else {
      startPage(from: snapshot)
    }
  }

  func itemDidAppear(_ identity: MediaIdentity) {
    guard
      libraryShouldLoadMore(
        state: state,
        visibleIdentity: identity,
        lookahead: Self.pageLookahead
      )
    else {
      return
    }
    loadMore()
  }

  func deactivate() {
    authorization = nil
    cancelActiveLoad()
    pageRecovery.reset()
    artworkWindow.deactivate()
    state = .loading
  }

  private var confirmedSnapshot: LibrarySnapshot? {
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

  private func startFirstPage(preserving snapshot: LibrarySnapshot?) {
    guard let currentAuthorization = authorization else {
      return
    }
    pageRecovery.reset()
    startLoad(
      pageToken: nil,
      confirmed: snapshot,
      kind: snapshot == nil ? .initial : .refresh,
      authorization: currentAuthorization
    )
    state = snapshot.map(LibraryState.refreshing) ?? .loading
  }

  private func startPage(
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
      pageRecovery.reset()
    }
    startLoad(
      pageToken: pageToken,
      confirmed: snapshot,
      kind: .page,
      authorization: currentAuthorization
    )
    state = .loadingMore(snapshot)
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
    guard context.pageToken == nil || page.nextPageToken != context.pageToken else {
      state = libraryFailureState(.incompatible, context: context)
      return
    }
    let confirmedItems =
      context.kind == .page
      ? context.confirmed?.items ?? []
      : []
    let items = appendingUniqueLibraryItems(confirmedItems, page.items)
    let snapshot = LibrarySnapshot(
      query: context.query,
      items: items,
      nextPageToken: page.nextPageToken
    )
    state = items.isEmpty ? .empty : .content(snapshot)
    artworkWindow.collectionsDidChange(LibraryArtworkProjection.collections(items: items))
    advancePageRecovery(
      from: context.confirmed?.items.count ?? 0,
      snapshot: snapshot,
      requestedPageToken: context.pageToken
    )
  }

  private func startExpiredPageRecovery(from snapshot: LibrarySnapshot) {
    guard let currentAuthorization = authorization else {
      return
    }
    pageRecovery.begin(confirmedItemCount: snapshot.items.count)
    startLoad(
      pageToken: nil,
      confirmed: snapshot,
      kind: .page,
      authorization: currentAuthorization
    )
    state = .loadingMore(snapshot)
  }

  private func advancePageRecovery(
    from confirmedItemCount: Int,
    snapshot: LibrarySnapshot,
    requestedPageToken: String?
  ) {
    switch pageRecovery.action(
      confirmedItemCount: confirmedItemCount,
      snapshot: snapshot,
      requestedPageToken: requestedPageToken
    ) {
    case .finished:
      return

    case .loadMore:
      startPage(from: snapshot, continuingRecovery: true)

    case .incompatible:
      state = .pageFailed(snapshot, .incompatible)
    }
  }

  private func cancelActiveLoad() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
