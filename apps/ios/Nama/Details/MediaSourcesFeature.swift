import Observation

@MainActor
@Observable
final class MediaSourcesFeature {
  private(set) var state: MediaSourcesState = .idle

  @ObservationIgnored private let loader: any MediaSourceLoading
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var selection: MediaSourcesSelection?
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = .zero
  @ObservationIgnored private var deactivatedInspectedSourceIdentity: MediaSourceIdentity?

  init(loader: any MediaSourceLoading) {
    self.loader = loader
  }

  deinit {
    activeTask?.cancel()
  }

  func select(
    _ newSelection: MediaSourcesSelection,
    authorization newAuthorization: HomeAuthorizationIdentity
  ) {
    if selection == newSelection, authorization == newAuthorization {
      guard let sourceIdentity = deactivatedInspectedSourceIdentity else {
        return
      }
      deactivatedInspectedSourceIdentity = nil
      inspect(sourceIdentity)
      return
    }
    activeTask?.cancel()
    attempt &+= 1
    deactivatedInspectedSourceIdentity = nil
    selection = newSelection
    authorization = newAuthorization
    state = .choosing(newSelection)
  }

  func deactivate(_ expectedSelection: MediaSourcesSelection) {
    guard selection == expectedSelection else {
      return
    }
    deactivatedInspectedSourceIdentity = nil
    if case .inspected(let inspectedSelection, let summary, _) = state,
      inspectedSelection == expectedSelection
    {
      deactivatedInspectedSourceIdentity = summary.identity
    }
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
    if case .loading = state {
      state = .choosing(expectedSelection)
    }
  }

  func inspect(_ sourceIdentity: MediaSourceIdentity) {
    deactivatedInspectedSourceIdentity = nil
    guard
      let selection,
      let authorization,
      let summary = selection.sourceSummaries.first(where: { $0.identity == sourceIdentity })
    else {
      return
    }

    activeTask?.cancel()
    attempt &+= 1
    let expectedAttempt = attempt
    state = .loading(selection, summary)
    activeTask = Task { [weak self, loader] in
      let result: Result<MediaSource, any Error>
      do {
        result = .success(
          try await loader.loadSource(
            mediaIdentity: selection.mediaIdentity,
            sourceIdentity: summary.identity,
            authorization: authorization
          )
        )
      } catch {
        result = .failure(error)
      }
      guard let self else {
        return
      }
      finish(
        result,
        selection: selection,
        summary: summary,
        authorization: authorization,
        attempt: expectedAttempt
      )
    }
  }

  func retry() {
    let summary: MediaSourceSummary
    switch state {
    case .failed(_, let failedSummary, _):
      summary = failedSummary

    case .inspected(_, let inspectedSummary, let source)
    where source.availability != .available:
      summary = inspectedSummary

    case .idle, .choosing, .loading, .inspected:
      return
    }
    inspect(summary.identity)
  }

  func play() -> MediaPlayIntent? {
    guard
      case .inspected(let selection, let summary, let source) = state,
      source.availability == .available
    else {
      return nil
    }
    return MediaPlayIntent(
      mediaIdentity: selection.mediaIdentity,
      sourceIdentity: summary.identity
    )
  }

  private func finish(
    _ result: Result<MediaSource, any Error>,
    selection expectedSelection: MediaSourcesSelection,
    summary: MediaSourceSummary,
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
    case .success(let source):
      state = .inspected(expectedSelection, summary, source)

    case .failure(let error):
      state = .failed(
        expectedSelection,
        summary,
        error as? MediaSourceFailure ?? .incompatible
      )
    }
  }
}
