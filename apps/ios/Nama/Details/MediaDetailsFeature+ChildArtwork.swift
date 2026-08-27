private struct MediaChildArtworkRequest {
  let parent: MediaDetailsSelection
  let child: MediaIdentity
  let reference: ArtworkIdentity
  let authorization: HomeAuthorizationIdentity
}

private struct MediaCreditArtworkRequest {
  let selection: MediaDetailsSelection
  let credit: MediaCreditIdentity
  let reference: ArtworkIdentity
  let authorization: HomeAuthorizationIdentity
}

extension MediaDetailsFeature {
  func childArtworkPresentationState(
    for identity: MediaIdentity
  ) -> HomeArtworkPresentationState {
    if let state = childArtworkStates[identity] {
      return state
    }
    let state = HomeArtworkPresentationState()
    childArtworkStates[identity] = state
    return state
  }

  func childArtworkDidAppear(
    _ item: MediaSummary,
    size: ArtworkSizeBucket
  ) {
    let state = childArtworkPresentationState(for: item.identity)
    guard
      let parent = selection,
      let authorization,
      let currentItem = childrenState.confirmedItems.first(where: { candidate in
        candidate.identity == item.identity
      }),
      let reference = currentItem.preferredChildArtwork,
      reference.identity == item.preferredChildArtwork?.identity
    else {
      childArtworkTasks.removeValue(forKey: item.identity)?.cancel()
      state.replace(with: nil)
      return
    }

    childArtworkTasks[item.identity]?.cancel()
    state.replace(with: nil)
    let request = MediaChildArtworkRequest(
      parent: parent,
      child: item.identity,
      reference: reference.identity,
      authorization: authorization
    )
    let currentArtworkLoader = artworkLoader
    childArtworkTasks[item.identity] = Task { [weak self] in
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
      self?.finishChildArtwork(presentation, request: request)
    }
  }

  func childArtworkDidDisappear(_ identity: MediaIdentity) {
    childArtworkTasks.removeValue(forKey: identity)?.cancel()
    childArtworkStates.removeValue(forKey: identity)?.replace(with: nil)
  }

  func cancelChildArtwork() {
    for task in childArtworkTasks.values {
      task.cancel()
    }
    childArtworkTasks.removeAll(keepingCapacity: true)
    for state in childArtworkStates.values {
      state.replace(with: nil)
    }
    childArtworkStates.removeAll(keepingCapacity: true)
  }

  private func finishChildArtwork(
    _ presentation: HomeArtworkPresentation?,
    request: MediaChildArtworkRequest
  ) {
    guard
      selection == request.parent,
      authorization == request.authorization,
      let item = childrenState.confirmedItems.first(where: { candidate in
        candidate.identity == request.child
      }),
      item.preferredChildArtwork?.identity == request.reference,
      let state = childArtworkStates[request.child]
    else {
      return
    }
    childArtworkTasks[request.child] = nil
    state.replace(with: presentation)
  }
}

extension MediaDetailsFeature {
  func creditArtworkPresentationState(
    for identity: MediaCreditIdentity
  ) -> HomeArtworkPresentationState {
    if let state = creditArtworkStates[identity] {
      return state
    }
    let state = HomeArtworkPresentationState()
    creditArtworkStates[identity] = state
    return state
  }

  func creditArtworkDidAppear(
    _ credit: MediaCredit,
    size: ArtworkSizeBucket
  ) {
    let state = creditArtworkPresentationState(for: credit.identity)
    guard
      let selection,
      let authorization,
      let currentCredit = confirmedDetails?.credits.first(where: { candidate in
        candidate.identity == credit.identity
      }),
      let reference = currentCredit.portraitArtwork,
      reference.identity == credit.portraitArtwork?.identity
    else {
      creditArtworkTasks.removeValue(forKey: credit.identity)?.cancel()
      state.replace(with: nil)
      return
    }

    creditArtworkTasks[credit.identity]?.cancel()
    state.replace(with: nil)
    let request = MediaCreditArtworkRequest(
      selection: selection,
      credit: credit.identity,
      reference: reference.identity,
      authorization: authorization
    )
    let currentArtworkLoader = artworkLoader
    creditArtworkTasks[credit.identity] = Task { [weak self] in
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
      self?.finishCreditArtwork(presentation, request: request)
    }
  }

  func creditArtworkDidDisappear(_ identity: MediaCreditIdentity) {
    creditArtworkTasks.removeValue(forKey: identity)?.cancel()
    creditArtworkStates.removeValue(forKey: identity)?.replace(with: nil)
  }

  func cancelCreditArtwork() {
    for task in creditArtworkTasks.values {
      task.cancel()
    }
    creditArtworkTasks.removeAll(keepingCapacity: true)
    for state in creditArtworkStates.values {
      state.replace(with: nil)
    }
    creditArtworkStates.removeAll(keepingCapacity: true)
  }

  private func finishCreditArtwork(
    _ presentation: HomeArtworkPresentation?,
    request: MediaCreditArtworkRequest
  ) {
    guard
      selection == request.selection,
      authorization == request.authorization,
      let credit = confirmedDetails?.credits.first(where: { candidate in
        candidate.identity == request.credit
      }),
      credit.portraitArtwork?.identity == request.reference,
      let state = creditArtworkStates[request.credit]
    else {
      return
    }
    creditArtworkTasks[request.credit] = nil
    state.replace(with: presentation)
  }
}
