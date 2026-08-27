private struct MediaChildPageLoad {
  let items: [MediaSummary]
  let pageToken: String?
}

private struct MediaChildPageAttempt {
  let load: MediaChildPageLoad
  let selection: MediaDetailsSelection
  let authorization: HomeAuthorizationIdentity
  let attempt: UInt64
}

extension MediaDetailsFeature {
  func loadMoreChildren() {
    startChildPageLoad(continuingExpiredPageRecovery: false)
  }

  private func continueExpiredPageRecovery() {
    startChildPageLoad(continuingExpiredPageRecovery: true)
  }

  private func startChildPageLoad(continuingExpiredPageRecovery: Bool) {
    guard
      childPageTask == nil,
      let selection,
      let authorization,
      let load = childPageLoad
    else {
      return
    }
    if continuingExpiredPageRecovery {
      guard childPageRecoveryIsActive else {
        return
      }
    } else {
      childPageRecoveryIsActive = false
      childPageRecoveryTokens.removeAll(keepingCapacity: true)
      childPageRecoveryRemainingContinuations = 0
      if case .pageFailed(_, _, .pageTokenInvalid) = childrenState {
        childPageRecoveryIsActive = true
        childPageRecoveryRemainingContinuations = load.items.count
      }
    }

    childrenState = .loadingMore(items: load.items, pageToken: load.pageToken)
    childPageAttempt &+= 1
    let context = MediaChildPageAttempt(
      load: load,
      selection: selection,
      authorization: authorization,
      attempt: childPageAttempt
    )
    let currentLoader = loader
    childPageTask = Task { [weak self] in
      let result: Result<MediaChildrenPage, any Error>
      do {
        result = .success(
          try await currentLoader.loadChildren(
            for: context.selection,
            pageToken: context.load.pageToken,
            authorization: context.authorization
          )
        )
      } catch {
        result = .failure(error)
      }
      guard !Task.isCancelled else {
        return
      }
      self?.finishChildPage(result, context: context)
    }
  }

  func childDidAppear(_ identity: MediaIdentity) {
    guard
      case .content(let items, let nextPageToken) = childrenState,
      nextPageToken != nil,
      let index = items.firstIndex(where: { $0.identity == identity }),
      items.distance(from: index, to: items.endIndex)
        <= MediaDetailsFeatureBounds.childPageLookahead
    else {
      return
    }
    loadMoreChildren()
  }

  private var childPageLoad: MediaChildPageLoad? {
    switch childrenState {
    case .content(let items, let nextPageToken):
      nextPageToken.map { MediaChildPageLoad(items: items, pageToken: $0) }

    case .pageFailed(let items, let pageToken, let failure):
      MediaChildPageLoad(
        items: items,
        pageToken: failure == .pageTokenInvalid ? nil : pageToken
      )

    case .notApplicable, .loading, .loadingMore:
      nil
    }
  }

  private func finishChildPage(
    _ result: Result<MediaChildrenPage, any Error>,
    context: MediaChildPageAttempt
  ) {
    guard
      selection == context.selection,
      authorization == context.authorization,
      childPageAttempt == context.attempt,
      case .loadingMore(_, let activePageToken) = childrenState,
      activePageToken == context.load.pageToken
    else {
      return
    }
    childPageTask = nil
    switch result {
    case .success(let page):
      finishSuccessfulChildPage(page, context: context)

    case .failure(let error):
      let failure =
        (error as? MediaDetailsFailure)
        ?? .namaUnavailable(requestID: nil, retryAfterSeconds: nil)
      childrenState = .pageFailed(
        items: context.load.items,
        pageToken: context.load.pageToken,
        failure: failure
      )
    }
  }

  private func finishSuccessfulChildPage(
    _ page: MediaChildrenPage,
    context: MediaChildPageAttempt
  ) {
    guard
      context.load.pageToken == nil
        || page.nextPageToken != context.load.pageToken
    else {
      childrenState = .pageFailed(
        items: context.load.items,
        pageToken: context.load.pageToken,
        failure: .incompatible
      )
      return
    }
    let items = Self.appendingUniqueChildren(context.load.items, page.items)
    childrenState = .content(
      items: items,
      nextPageToken: page.nextPageToken
    )
    if !childPageRecoveryIsActive,
      items.count == context.load.items.count,
      page.nextPageToken != nil
    {
      childPageRecoveryIsActive = true
      childPageRecoveryTokens.removeAll(keepingCapacity: true)
      childPageRecoveryRemainingContinuations = items.count
    }
    guard childPageRecoveryIsActive else {
      return
    }
    guard items.count == context.load.items.count else {
      resetExpiredPageRecovery()
      return
    }
    guard let nextPageToken = page.nextPageToken else {
      resetExpiredPageRecovery()
      return
    }
    guard
      childPageRecoveryRemainingContinuations > 0,
      childPageRecoveryTokens.insert(nextPageToken).inserted
    else {
      resetExpiredPageRecovery()
      childrenState = .pageFailed(
        items: items,
        pageToken: nextPageToken,
        failure: .incompatible
      )
      return
    }
    childPageRecoveryRemainingContinuations -= 1
    continueExpiredPageRecovery()
  }

  private func resetExpiredPageRecovery() {
    childPageRecoveryIsActive = false
    childPageRecoveryTokens.removeAll(keepingCapacity: true)
    childPageRecoveryRemainingContinuations = 0
  }

  static func appendingUniqueChildren(
    _ confirmed: [MediaSummary],
    _ candidates: [MediaSummary]
  ) -> [MediaSummary] {
    var identities = Set(confirmed.map(\.identity))
    return confirmed
      + candidates.filter { item in
        identities.insert(item.identity).inserted
      }
  }
}

private enum MediaDetailsFeatureBounds {
  static let childPageLookahead = 2
}
