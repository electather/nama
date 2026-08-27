import Observation

@MainActor
@Observable
final class HomeArtworkWindow {
  private static let usefulItemCount = 3

  @ObservationIgnored private var presentationStates:
    [HomeMediaIdentity: HomeArtworkPresentationState] = [:]

  @ObservationIgnored private let loader: any HomeArtworkLoading
  @ObservationIgnored private var authorizationTask: Task<Void, Never>?
  @ObservationIgnored private var tasks: [HomeArtworkRequestKey: Task<Void, Never>] = [:]
  @ObservationIgnored private var visibleArtwork:
    [HomeShelfIdentity: [HomeMediaIdentity: HomeArtworkSizeBucket]] = [:]
  @ObservationIgnored private var usefulRequests: Set<HomeArtworkRequestKey> = []
  @ObservationIgnored private var completedRequests: Set<HomeArtworkRequestKey> = []
  @ObservationIgnored private var presentedRequests: [HomeMediaIdentity: HomeArtworkRequestKey] =
    [:]
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var snapshot: HomeSnapshot?

  init(loader: any HomeArtworkLoading) {
    self.loader = loader
  }

  deinit {
    authorizationTask?.cancel()
    for task in tasks.values {
      task.cancel()
    }
  }

  func authorizationDidChange(to newAuthorization: HomeAuthorizationIdentity) {
    authorization = newAuthorization
    cancelWork(clearPresentations: true)
    let previousAuthorizationTask = authorizationTask
    previousAuthorizationTask?.cancel()
    let currentLoader = loader
    authorizationTask = Task {
      await previousAuthorizationTask?.value
      guard !Task.isCancelled else {
        return
      }
      await currentLoader.authorizationDidChange(to: newAuthorization)
    }
  }

  func deactivate() {
    authorization = nil
    cancelWork(clearPresentations: false)
  }

  func snapshotDidChange(_ newSnapshot: HomeSnapshot) {
    snapshot = newSnapshot
    let mediaIdentities = Set(
      newSnapshot.shelves.flatMap { shelf in
        shelf.items.map(\.identity)
      }
    )
    let removedMedia = presentationStates.keys.filter { !mediaIdentities.contains($0) }
    for media in removedMedia {
      presentationStates.removeValue(forKey: media)?.replace(with: nil)
      presentedRequests.removeValue(forKey: media)
    }
    for media in mediaIdentities where presentationStates[media] == nil {
      presentationStates[media] = HomeArtworkPresentationState()
    }
    reconcile()
  }

  func presentationState(
    for media: HomeMediaIdentity
  ) -> HomeArtworkPresentationState? {
    presentationStates[media]
  }

  func artworkDidAppear(
    _ media: HomeMediaIdentity,
    in shelf: HomeShelfIdentity,
    size: HomeArtworkSizeBucket
  ) {
    visibleArtwork[shelf, default: [:]][media] = size
    reconcile()
  }

  func artworkDidDisappear(_ media: HomeMediaIdentity, in shelf: HomeShelfIdentity) {
    visibleArtwork[shelf]?.removeValue(forKey: media)
    if visibleArtwork[shelf]?.isEmpty == true {
      visibleArtwork.removeValue(forKey: shelf)
    }
    reconcile()
  }

  private func reconcile() {
    guard let snapshot, let currentAuthorization = authorization else {
      cancelTasks()
      return
    }
    let requests = requestedArtwork(in: snapshot)
    let nextUsefulRequests = Set(requests.values.map(\.key))
    usefulRequests = nextUsefulRequests
    cancelTasks(outside: nextUsefulRequests)
    completedRequests.formIntersection(nextUsefulRequests)
    prunePresentations(outside: nextUsefulRequests)
    start(requests, authorization: currentAuthorization)
  }

  private func requestedArtwork(
    in snapshot: HomeSnapshot
  ) -> [HomeMediaIdentity: HomeArtworkWindowRequest] {
    var requests: [HomeMediaIdentity: HomeArtworkWindowRequest] = [:]
    for (shelfIdentity, visibleItems) in visibleArtwork {
      guard let shelf = snapshot.shelves.first(where: { $0.identity == shelfIdentity }) else {
        continue
      }
      for (visibleMedia, size) in visibleItems {
        addUsefulArtwork(
          from: visibleMedia,
          size: size,
          shelf: shelf,
          to: &requests
        )
      }
    }
    return requests
  }

  private func addUsefulArtwork(
    from visibleMedia: HomeMediaIdentity,
    size: HomeArtworkSizeBucket,
    shelf: HomeShelf,
    to requests: inout [HomeMediaIdentity: HomeArtworkWindowRequest]
  ) {
    guard let visibleIndex = shelf.items.firstIndex(where: { $0.identity == visibleMedia }) else {
      return
    }
    let endIndex = min(
      shelf.items.endIndex,
      visibleIndex + Self.usefulItemCount
    )
    for item in shelf.items[visibleIndex..<endIndex] {
      guard let reference = item.preferredPosterArtwork else {
        continue
      }
      let key = HomeArtworkRequestKey(
        media: item.identity,
        reference: reference.identity,
        size: size
      )
      if let current = requests[item.identity], current.key.size.maxWidth >= size.maxWidth {
        continue
      }
      requests[item.identity] = HomeArtworkWindowRequest(key: key, reference: reference)
    }
  }

  private func cancelTasks(outside nextUsefulRequests: Set<HomeArtworkRequestKey>) {
    let obsoleteKeys = tasks.keys.filter { !nextUsefulRequests.contains($0) }
    for key in obsoleteKeys {
      tasks.removeValue(forKey: key)?.cancel()
    }
  }

  private func prunePresentations(
    outside nextUsefulRequests: Set<HomeArtworkRequestKey>
  ) {
    let obsoleteMedia = presentedRequests.compactMap { media, request in
      nextUsefulRequests.contains(request) ? nil : media
    }
    for media in obsoleteMedia {
      presentedRequests.removeValue(forKey: media)
      presentationStates[media]?.replace(with: nil)
    }
  }

  private func start(
    _ requests: [HomeMediaIdentity: HomeArtworkWindowRequest],
    authorization currentAuthorization: HomeAuthorizationIdentity
  ) {
    for (media, request) in requests {
      if let presented = presentedRequests[media], presented != request.key {
        presentedRequests.removeValue(forKey: media)
        presentationStates[media]?.replace(with: nil)
      }
      guard
        presentedRequests[media] != request.key,
        tasks[request.key] == nil,
        !completedRequests.contains(request.key)
      else {
        continue
      }
      start(request, authorization: currentAuthorization)
    }
  }

  private func start(
    _ request: HomeArtworkWindowRequest,
    authorization currentAuthorization: HomeAuthorizationIdentity
  ) {
    let currentLoader = loader
    let currentAuthorizationTask = authorizationTask
    tasks[request.key] = Task { [weak self] in
      await currentAuthorizationTask?.value
      guard !Task.isCancelled else {
        return
      }
      let presentation = await currentLoader.image(
        for: request.reference,
        size: request.key.size,
        authorization: currentAuthorization
      )
      guard !Task.isCancelled else {
        return
      }
      self?.finish(
        presentation,
        request: request.key,
        authorization: currentAuthorization
      )
    }
  }

  private func finish(
    _ presentation: HomeArtworkPresentation?,
    request: HomeArtworkRequestKey,
    authorization expectedAuthorization: HomeAuthorizationIdentity
  ) {
    tasks.removeValue(forKey: request)
    guard
      authorization == expectedAuthorization,
      usefulRequests.contains(request)
    else {
      return
    }
    completedRequests.insert(request)
    guard let presentation else {
      return
    }
    presentationStates[request.media]?.replace(with: presentation)
    presentedRequests[request.media] = request
  }

  private func cancelWork(clearPresentations: Bool) {
    cancelTasks()
    visibleArtwork.removeAll(keepingCapacity: false)
    completedRequests.removeAll(keepingCapacity: false)
    usefulRequests.removeAll(keepingCapacity: false)
    if clearPresentations {
      for state in presentationStates.values {
        state.replace(with: nil)
      }
      presentedRequests.removeAll(keepingCapacity: false)
    }
  }

  private func cancelTasks() {
    for task in tasks.values {
      task.cancel()
    }
    tasks.removeAll(keepingCapacity: false)
  }
}

nonisolated private struct HomeArtworkRequestKey: Hashable {
  let media: HomeMediaIdentity
  let reference: HomeArtworkIdentity
  let size: HomeArtworkSizeBucket
}

nonisolated private struct HomeArtworkWindowRequest {
  let key: HomeArtworkRequestKey
  let reference: HomeArtworkReference
}
