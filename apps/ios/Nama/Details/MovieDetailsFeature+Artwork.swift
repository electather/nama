private struct MovieDetailsArtworkRequest {
  let slot: MovieDetailsArtworkSlot
  let reference: HomeArtworkIdentity
  let media: HomeMediaIdentity
  let authorization: HomeAuthorizationIdentity
}

extension MovieDetailsFeature {
  func artworkPresentation(
    for slot: MovieDetailsArtworkSlot
  ) -> HomeArtworkPresentation? {
    switch slot {
    case .poster:
      posterArtworkPresentation

    case .backdrop:
      backdropArtworkPresentation
    }
  }

  func artworkDidAppear(
    _ slot: MovieDetailsArtworkSlot,
    size: HomeArtworkSizeBucket
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
      return
    }
    artworkTasks[slot]?.cancel()
    replaceArtworkPresentation(nil, for: slot)
    let request = MovieDetailsArtworkRequest(
      slot: slot,
      reference: reference.identity,
      media: details.identity,
      authorization: authorization
    )
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

  func artworkDidDisappear(_ slot: MovieDetailsArtworkSlot) {
    artworkTasks.removeValue(forKey: slot)?.cancel()
  }

  func cancelArtwork() {
    for task in artworkTasks.values {
      task.cancel()
    }
    artworkTasks.removeAll(keepingCapacity: true)
    posterArtworkPresentation = nil
    backdropArtworkPresentation = nil
  }

  private func artworkReference(
    for slot: MovieDetailsArtworkSlot,
    in details: MovieDetails
  ) -> HomeArtworkReference? {
    switch slot {
    case .poster:
      details.preferredPosterArtwork

    case .backdrop:
      details.preferredBackdropArtwork
    }
  }

  private func finishArtwork(
    _ presentation: HomeArtworkPresentation?,
    request: MovieDetailsArtworkRequest
  ) {
    guard
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
    for slot: MovieDetailsArtworkSlot
  ) {
    switch slot {
    case .poster:
      posterArtworkPresentation = presentation

    case .backdrop:
      backdropArtworkPresentation = presentation
    }
  }
}
