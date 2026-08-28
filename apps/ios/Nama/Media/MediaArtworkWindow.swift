import Observation

nonisolated struct MediaArtworkCollectionIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated enum MediaArtworkPreference: Equatable, Sendable {
  case poster
  case search

  func reference(for item: MediaSummary) -> ArtworkReference? {
    switch self {
    case .poster:
      return item.preferredPosterArtwork

    case .search:
      let role: ArtworkRole = item.kind == .episode ? .thumbnail : .poster
      return item.artwork.first { reference in
        reference.role == role && reference.textPresence == .textless
      } ?? item.artwork.first { $0.role == role }
    }
  }
}

nonisolated struct MediaArtworkCollection: Equatable, Sendable {
  let identity: MediaArtworkCollectionIdentity
  let items: [MediaSummary]
  let preference: MediaArtworkPreference

  init(
    identity: MediaArtworkCollectionIdentity,
    items: [MediaSummary],
    preference: MediaArtworkPreference = .poster
  ) {
    self.identity = identity
    self.items = items
    self.preference = preference
  }
}

@MainActor
@Observable
final class MediaArtworkWindow {
  private static let usefulItemCount = 3

  @ObservationIgnored private var presentationStates:
    [MediaIdentity: HomeArtworkPresentationState] = [:]

  @ObservationIgnored private let loader: any HomeArtworkLoading
  @ObservationIgnored private var authorizationTask: Task<Void, Never>?
  @ObservationIgnored private var tasks: [MediaArtworkRequestKey: Task<Void, Never>] = [:]
  @ObservationIgnored private var visibleArtwork:
    [MediaArtworkCollectionIdentity: [MediaIdentity: ArtworkSizeBucket]] = [:]
  @ObservationIgnored private var usefulRequests: Set<MediaArtworkRequestKey> = []
  @ObservationIgnored private var completedRequests: Set<MediaArtworkRequestKey> = []
  @ObservationIgnored private var presentedRequests: [MediaIdentity: MediaArtworkRequestKey] =
    [:]
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var collections: [MediaArtworkCollection] = []

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

  func collectionsDidChange(_ newCollections: [MediaArtworkCollection]) {
    collections = newCollections
    let mediaIdentities = Set(
      newCollections.flatMap { collection in
        collection.items.map(\.identity)
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
    for media: MediaIdentity
  ) -> HomeArtworkPresentationState? {
    presentationStates[media]
  }

  func artworkDidAppear(
    _ media: MediaIdentity,
    in collection: MediaArtworkCollectionIdentity,
    size: ArtworkSizeBucket
  ) {
    visibleArtwork[collection, default: [:]][media] = size
    reconcile()
  }

  func artworkDidDisappear(
    _ media: MediaIdentity,
    in collection: MediaArtworkCollectionIdentity
  ) {
    visibleArtwork[collection]?.removeValue(forKey: media)
    if visibleArtwork[collection]?.isEmpty == true {
      visibleArtwork.removeValue(forKey: collection)
    }
    reconcile()
  }

  private func reconcile() {
    guard let currentAuthorization = authorization else {
      cancelTasks()
      return
    }
    let requests = requestedArtwork()
    let nextUsefulRequests = Set(requests.values.map(\.key))
    usefulRequests = nextUsefulRequests
    cancelTasks(outside: nextUsefulRequests)
    completedRequests.formIntersection(nextUsefulRequests)
    prunePresentations(outside: nextUsefulRequests)
    start(requests, authorization: currentAuthorization)
  }

  private func requestedArtwork() -> [MediaIdentity: MediaArtworkWindowRequest] {
    var requests: [MediaIdentity: MediaArtworkWindowRequest] = [:]
    for (collectionIdentity, visibleItems) in visibleArtwork {
      guard let collection = collections.first(where: { $0.identity == collectionIdentity }) else {
        continue
      }
      for (visibleMedia, size) in visibleItems {
        addUsefulArtwork(
          from: visibleMedia,
          size: size,
          collection: collection,
          to: &requests
        )
      }
    }
    return requests
  }

  private func addUsefulArtwork(
    from visibleMedia: MediaIdentity,
    size: ArtworkSizeBucket,
    collection: MediaArtworkCollection,
    to requests: inout [MediaIdentity: MediaArtworkWindowRequest]
  ) {
    guard
      let visibleIndex = collection.items.firstIndex(where: { $0.identity == visibleMedia })
    else {
      return
    }
    let endIndex = min(
      collection.items.endIndex,
      visibleIndex + Self.usefulItemCount
    )
    for item in collection.items[visibleIndex..<endIndex] {
      guard let reference = collection.preference.reference(for: item) else {
        continue
      }
      let key = MediaArtworkRequestKey(
        media: item.identity,
        reference: reference.identity,
        size: size
      )
      if let current = requests[item.identity], current.key.size.maxWidth >= size.maxWidth {
        continue
      }
      requests[item.identity] = MediaArtworkWindowRequest(key: key, reference: reference)
    }
  }

  private func cancelTasks(outside nextUsefulRequests: Set<MediaArtworkRequestKey>) {
    let obsoleteKeys = tasks.keys.filter { !nextUsefulRequests.contains($0) }
    for key in obsoleteKeys {
      tasks.removeValue(forKey: key)?.cancel()
    }
  }

  private func prunePresentations(
    outside nextUsefulRequests: Set<MediaArtworkRequestKey>
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
    _ requests: [MediaIdentity: MediaArtworkWindowRequest],
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
    _ request: MediaArtworkWindowRequest,
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
    request: MediaArtworkRequestKey,
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

nonisolated private struct MediaArtworkRequestKey: Hashable {
  let media: MediaIdentity
  let reference: ArtworkIdentity
  let size: ArtworkSizeBucket
}

nonisolated private struct MediaArtworkWindowRequest {
  let key: MediaArtworkRequestKey
  let reference: ArtworkReference
}
