import Observation

private struct MediaDetailsLoadResult {
  let details: MediaDetails
  let selection: MediaDetailsSelection
  let children: MediaChildrenPage?
}

private func mediaKindLoadsChildren(_ kind: MediaKind?) -> Bool {
  kind == .show || kind == .season
}

private func loadMediaDetails(
  using loader: any MediaChildrenLoading & MediaDetailsLoading,
  selection: MediaDetailsSelection,
  authorization: HomeAuthorizationIdentity
) async -> Result<MediaDetailsLoadResult, any Error> {
  do {
    let details = try await loader.load(
      selection,
      authorization: authorization
    )
    let loadedSelection = details.selection
    let children: MediaChildrenPage?
    if mediaKindLoadsChildren(loadedSelection.kind) {
      children = try await loader.loadChildren(
        for: loadedSelection,
        pageToken: nil,
        authorization: authorization
      )
    } else {
      children = nil
    }
    return .success(
      MediaDetailsLoadResult(
        details: details,
        selection: loadedSelection,
        children: children
      )
    )
  } catch {
    return .failure(error)
  }
}

@MainActor
@Observable
final class MediaDetailsFeature {
  private(set) var state: MediaDetailsState = .idle
  var childrenState: MediaChildrenState = .notApplicable
  var posterArtworkPresentation: HomeArtworkPresentation?
  var backdropArtworkPresentation: HomeArtworkPresentation?

  @ObservationIgnored let loader: any MediaChildrenLoading & MediaDetailsLoading
  @ObservationIgnored let artworkLoader: any HomeArtworkLoading
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored var childPageTask: Task<Void, Never>?
  @ObservationIgnored var artworkTasks: [MediaDetailsArtworkSlot: Task<Void, Never>] = [:]
  @ObservationIgnored var artworkRequests: [MediaDetailsArtworkSlot: MediaDetailsArtworkRequest] =
    [:]
  @ObservationIgnored var childArtworkTasks: [MediaIdentity: Task<Void, Never>] = [:]
  @ObservationIgnored var childArtworkStates: [MediaIdentity: HomeArtworkPresentationState] = [:]
  @ObservationIgnored var creditArtworkTasks: [MediaCreditIdentity: Task<Void, Never>] = [:]
  @ObservationIgnored var creditArtworkStates: [MediaCreditIdentity: HomeArtworkPresentationState] =
    [:]
  @ObservationIgnored var selection: MediaDetailsSelection?
  @ObservationIgnored var canonicalSelection: MediaDetailsSelection?
  @ObservationIgnored var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = .zero
  @ObservationIgnored var childPageAttempt: UInt64 = .zero
  @ObservationIgnored var childPageRecoveryIsActive = false
  @ObservationIgnored var childPageRecoveryTokens = Set<String>()
  @ObservationIgnored var childPageRecoveryRemainingContinuations = 0

  init(
    loader: any MediaChildrenLoading & MediaDetailsLoading,
    artworkLoader: any HomeArtworkLoading
  ) {
    self.loader = loader
    self.artworkLoader = artworkLoader
  }

  deinit {
    activeTask?.cancel()
    childPageTask?.cancel()
    for task in childArtworkTasks.values {
      task.cancel()
    }
    for task in creditArtworkTasks.values {
      task.cancel()
    }
    for task in artworkTasks.values {
      task.cancel()
    }
  }

  func select(
    _ newSelection: MediaDetailsSelection,
    authorization newAuthorization: HomeAuthorizationIdentity
  ) {
    guard selection != newSelection || authorization != newAuthorization else {
      return
    }
    cancelArtwork()
    cancelChildArtwork()
    cancelCreditArtwork()
    canonicalSelection = nil
    selection = newSelection
    authorization = newAuthorization
    startLoad(
      selection: newSelection,
      authorization: newAuthorization,
      preserving: nil
    )
  }

  func deactivate(_ expectedSelection: MediaDetailsSelection) {
    guard selection == expectedSelection else {
      return
    }
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
    cancelChildPageRequest()
    selection = nil
    canonicalSelection = nil
    authorization = nil
    cancelArtwork()
    cancelChildArtwork()
    cancelCreditArtwork()
    childrenState = .notApplicable
    state = .idle
  }

  func refresh() {
    guard
      let selection,
      let authorization,
      let details = confirmedDetails
    else {
      return
    }
    startLoad(
      selection: selection,
      authorization: authorization,
      preserving: details
    )
  }

  func retry() {
    guard let selection, let authorization else {
      return
    }
    startLoad(
      selection: selection,
      authorization: authorization,
      preserving: confirmedDetails
    )
  }

  func play() -> MediaPlayIntent? {
    guard let details = confirmedDetails else {
      return nil
    }
    switch details.kindDetails {
    case .movie, .episode:
      break

    case .show, .season:
      return nil
    }
    guard
      details.playability == .playable,
      let defaultSource = details.defaultSource,
      defaultSource.isDefault,
      defaultSource.availability == .available
    else {
      return nil
    }
    return MediaPlayIntent(mediaIdentity: details.identity)
  }

  var confirmedDetails: MediaDetails? {
    switch state {
    case .content(let details), .refreshing(let details), .refreshFailed(let details, _):
      details

    case .idle, .loading, .failed:
      nil
    }
  }

  func cancelChildPageRequest() {
    let shouldPreserveExpiredPageRecovery = childPageRecoveryIsActive
    childPageTask?.cancel()
    childPageTask = nil
    childPageAttempt &+= 1
    childPageRecoveryIsActive = false
    childPageRecoveryTokens.removeAll(keepingCapacity: true)
    childPageRecoveryRemainingContinuations = 0
    if case .loadingMore(let items, let pageToken) = childrenState {
      childrenState =
        shouldPreserveExpiredPageRecovery && pageToken == nil
        ? .pageFailed(items: items, pageToken: nil, failure: .pageTokenInvalid)
        : .content(items: items, nextPageToken: pageToken)
    }
  }

  private func startLoad(
    selection expectedSelection: MediaDetailsSelection,
    authorization expectedAuthorization: HomeAuthorizationIdentity,
    preserving details: MediaDetails?
  ) {
    activeTask?.cancel()
    cancelChildPageRequest()
    attempt &+= 1
    let expectedAttempt = attempt
    if details == nil {
      childrenState =
        expectedSelection.kind == nil
          || mediaKindLoadsChildren(expectedSelection.kind)
        ? .loading
        : .notApplicable
    }
    state = details.map(MediaDetailsState.refreshing) ?? .loading(expectedSelection)
    let currentLoader = loader
    activeTask = Task { [weak self] in
      let result = await loadMediaDetails(
        using: currentLoader,
        selection: expectedSelection,
        authorization: expectedAuthorization
      )
      guard !Task.isCancelled else {
        return
      }
      self?.finish(
        result,
        preserving: details,
        selection: expectedSelection,
        authorization: expectedAuthorization,
        attempt: expectedAttempt
      )
    }
  }

  private func finish(
    _ result: Result<MediaDetailsLoadResult, any Error>,
    preserving details: MediaDetails?,
    selection expectedSelection: MediaDetailsSelection,
    authorization expectedAuthorization: HomeAuthorizationIdentity,
    attempt expectedAttempt: UInt64
  ) {
    guard
      selection == expectedSelection,
      authorization == expectedAuthorization,
      attempt == expectedAttempt
    else {
      return
    }
    activeTask = nil
    switch result {
    case .success(let replacement):
      cancelChildPageRequest()
      cancelCreditArtwork()
      canonicalSelection = replacement.selection
      state = .content(replacement.details)
      childrenState =
        replacement.children.map { page in
          .content(
            items: Self.appendingUniqueChildren([], page.items),
            nextPageToken: page.nextPageToken
          )
        } ?? .notApplicable

    case .failure(let error):
      let failure =
        (error as? MediaDetailsFailure)
        ?? .namaUnavailable(requestID: nil, retryAfterSeconds: nil)
      if details == nil {
        childrenState = .notApplicable
      }
      state =
        details.map { .refreshFailed($0, failure) }
        ?? .failed(expectedSelection, failure)
    }
  }
}
