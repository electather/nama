import Observation

private func homeArtworkCollections(_ snapshot: HomeSnapshot) -> [MediaArtworkCollection] {
  snapshot.shelves.map { shelf in
    MediaArtworkCollection(
      identity: MediaArtworkCollectionIdentity(shelf.identity.rawValue),
      items: shelf.items
    )
  }
}

@MainActor
@Observable
final class HomeFeature {
  private(set) var state: HomeState = .loading

  @ObservationIgnored private let loader: any HomeLoading
  @ObservationIgnored private let artworkWindow: MediaArtworkWindow
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = .zero

  init(loader: any HomeLoading, artworkLoader: any HomeArtworkLoading) {
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
    startLoad(preserving: nil)
  }

  func refresh() {
    guard authorization != nil else {
      return
    }
    startLoad(preserving: confirmedSnapshot)
  }

  func retry() {
    guard authorization != nil else {
      return
    }
    startLoad(preserving: nil)
  }

  func deactivate() {
    authorization = nil
    cancelActiveLoad()
    artworkWindow.deactivate()
    state = .loading
  }

  func artworkPresentationState(
    for media: MediaIdentity
  ) -> HomeArtworkPresentationState? {
    artworkWindow.presentationState(for: media)
  }

  func artworkDidAppear(
    _ media: MediaIdentity,
    in shelf: HomeShelfIdentity,
    size: ArtworkSizeBucket
  ) {
    artworkWindow.artworkDidAppear(
      media,
      in: MediaArtworkCollectionIdentity(shelf.rawValue),
      size: size
    )
  }

  func artworkDidDisappear(_ media: MediaIdentity, in shelf: HomeShelfIdentity) {
    artworkWindow.artworkDidDisappear(
      media,
      in: MediaArtworkCollectionIdentity(shelf.rawValue)
    )
  }

  private var confirmedSnapshot: HomeSnapshot? {
    switch state {
    case .content(let snapshot), .refreshing(let snapshot),
      .refreshFailed(let snapshot, _):
      snapshot

    case .loading, .catalogNotReady, .empty, .failed:
      nil
    }
  }

  private func startLoad(preserving snapshot: HomeSnapshot?) {
    guard let currentAuthorization = authorization else {
      return
    }
    cancelActiveLoad()
    attempt &+= 1
    let currentAttempt = attempt
    state = snapshot.map(HomeState.refreshing) ?? .loading
    let currentLoader = loader

    activeTask = Task { [weak self] in
      let result: Result<HomeSnapshot, any Error>
      do {
        result = .success(try await currentLoader.load(for: currentAuthorization))
      } catch {
        result = .failure(error)
      }
      guard !Task.isCancelled else {
        return
      }
      self?.finish(
        result,
        authorization: currentAuthorization,
        attempt: currentAttempt
      )
    }
  }

  private func finish(
    _ result: Result<HomeSnapshot, any Error>,
    authorization expectedAuthorization: HomeAuthorizationIdentity,
    attempt expectedAttempt: UInt64
  ) {
    guard
      authorization == expectedAuthorization,
      attempt == expectedAttempt
    else {
      return
    }
    activeTask = nil
    let refreshingSnapshot: HomeSnapshot?
    if case .refreshing(let snapshot) = state {
      refreshingSnapshot = snapshot
    } else {
      refreshingSnapshot = nil
    }

    switch result {
    case .success(let snapshot):
      state = snapshot.isEmpty ? .empty : .content(snapshot)
      artworkWindow.collectionsDidChange(homeArtworkCollections(snapshot))

    case .failure(is CancellationError):
      return

    case .failure(let failure as HomeLoadingFailure):
      publish(failure, preserving: refreshingSnapshot)

    case .failure:
      publish(.incompatible, preserving: refreshingSnapshot)
    }
  }

  private func publish(
    _ failure: HomeLoadingFailure,
    preserving snapshot: HomeSnapshot?
  ) {
    if let snapshot {
      state = .refreshFailed(snapshot, failure)
      return
    }
    switch failure {
    case .catalogNotReady(let retryAfterSeconds):
      state = .catalogNotReady(retryAfterSeconds: retryAfterSeconds)

    case .authorizationUnavailable, .networkUnavailable, .namaUnavailable, .incompatible:
      state = .failed(failure)
    }
  }

  private func cancelActiveLoad() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
