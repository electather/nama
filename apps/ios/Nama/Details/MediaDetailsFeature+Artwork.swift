nonisolated struct MediaDetailsArtworkRequest: Equatable, Sendable {
  let slot: MediaDetailsArtworkSlot
  let reference: ArtworkIdentity
  let media: MediaIdentity
  let size: ArtworkSizeBucket
  let authorization: HomeAuthorizationIdentity
}

extension MediaDetailsFeature {
  func artworkPresentation(
    for slot: MediaDetailsArtworkSlot
  ) -> HomeArtworkPresentation? {
    switch slot {
    case .poster:
      posterArtworkPresentation

    case .backdrop:
      backdropArtworkPresentation
    }
  }

  func artworkDidAppear(
    _ slot: MediaDetailsArtworkSlot,
    size: ArtworkSizeBucket
  ) {
    guard
      let details = confirmedDetails,
      let authorization
    else {
      return
    }
    guard let reference = artworkReference(for: slot, in: details) else {
      artworkTasks.removeValue(forKey: slot)?.cancel()
      replaceArtworkPresentation(nil, for: slot)
      artworkRequests[slot] = nil
      return
    }
    let request = MediaDetailsArtworkRequest(
      slot: slot,
      reference: reference.identity,
      media: details.identity,
      size: size,
      authorization: authorization
    )
    guard artworkRequests[slot] != request else {
      return
    }
    artworkRequests[slot] = request
    artworkTasks[slot]?.cancel()
    replaceArtworkPresentation(nil, for: slot)
    let currentArtworkLoader = artworkLoader
    artworkTasks[slot] = Task { [weak self] in
      await currentArtworkLoader.authorizationDidChange(to: request.authorization)
      guard !Task.isCancelled else {
        return
      }
      let presentation = await currentArtworkLoader.image(
        for: reference,
        size: size,
        authorization: request.authorization
      )
      guard !Task.isCancelled else {
        return
      }
      self?.finishArtwork(presentation, request: request)
    }
  }

  func artworkDidDisappear(_ slot: MediaDetailsArtworkSlot) {
    artworkRequests[slot] = nil
    artworkTasks.removeValue(forKey: slot)?.cancel()
  }

  func cancelArtwork() {
    for task in artworkTasks.values {
      task.cancel()
    }
    artworkTasks.removeAll(keepingCapacity: true)
    artworkRequests.removeAll(keepingCapacity: true)
    posterArtworkPresentation = nil
    backdropArtworkPresentation = nil
  }

  private func artworkReference(
    for slot: MediaDetailsArtworkSlot,
    in details: MediaDetails
  ) -> ArtworkReference? {
    switch slot {
    case .poster:
      details.preferredPosterArtwork

    case .backdrop:
      details.preferredBackdropArtwork
    }
  }

  private func finishArtwork(
    _ presentation: HomeArtworkPresentation?,
    request: MediaDetailsArtworkRequest
  ) {
    guard
      artworkRequests[request.slot] == request,
      authorization == request.authorization,
      let details = confirmedDetails,
      details.identity == request.media,
      artworkReference(for: request.slot, in: details)?.identity == request.reference
    else {
      return
    }
    artworkTasks[request.slot] = nil
    replaceArtworkPresentation(presentation, for: request.slot)
  }

  private func replaceArtworkPresentation(
    _ presentation: HomeArtworkPresentation?,
    for slot: MediaDetailsArtworkSlot
  ) {
    switch slot {
    case .poster:
      posterArtworkPresentation = presentation

    case .backdrop:
      backdropArtworkPresentation = presentation
    }
  }
}
