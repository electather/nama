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
      let pageSelection = canonicalSelection ?? selection,
      let authorization,
      let load = childPageLoad
    else {
      return
    }
    if continuingExpiredPageRecovery {
      guard childPageContinuation.isActive else {
        return
      }
    } else {
      childPageContinuation.begin(
        currentPageToken: load.pageToken,
        continuationAllowance: load.items.count
      )
    }

    childrenState = .loadingMore(items: load.items, pageToken: load.pageToken)
    childPageAttempt &+= 1
    let context = MediaChildPageAttempt(
      load: load,
      selection: pageSelection,
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
      (canonicalSelection ?? selection) == context.selection,
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
    let items = appendingUniqueMediaSummaries(context.load.items, page.items)
    let pageAddedIdentities = items.count > context.load.items.count
    switch childPageContinuation.transition(
      pageAddedIdentities: pageAddedIdentities,
      nextPageToken: page.nextPageToken
    ) {
    case .finished:
      childrenState = .content(
        items: items,
        nextPageToken: page.nextPageToken
      )

    case .loadNext:
      childrenState = .content(
        items: items,
        nextPageToken: page.nextPageToken
      )
      continueExpiredPageRecovery()

    case .incompatible:
      childrenState = .pageFailed(
        items: items,
        pageToken: page.nextPageToken,
        failure: .incompatible
      )
    }
  }
}

private enum MediaDetailsFeatureBounds {
  static let childPageLookahead = 2
}
