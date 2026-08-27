import Observation

@MainActor
@Observable
final class MovieDetailsFeature {
  private(set) var state: MovieDetailsState = .idle
  var posterArtworkPresentation: HomeArtworkPresentation?
  var backdropArtworkPresentation: HomeArtworkPresentation?

  @ObservationIgnored private let loader: any MovieDetailsLoading
  @ObservationIgnored let artworkLoader: any HomeArtworkLoading
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored var artworkTasks: [MovieDetailsArtworkSlot: Task<Void, Never>] = [:]
  @ObservationIgnored var artworkRequests: [MovieDetailsArtworkSlot: MovieDetailsArtworkRequest] =
    [:]
  @ObservationIgnored private var selection: MovieDetailsSelection?
  @ObservationIgnored var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = .zero

  init(
    loader: any MovieDetailsLoading,
    artworkLoader: any HomeArtworkLoading
  ) {
    self.loader = loader
    self.artworkLoader = artworkLoader
  }

  deinit {
    activeTask?.cancel()
    for task in artworkTasks.values {
      task.cancel()
    }
  }

  func select(
    _ newSelection: MovieDetailsSelection,
    authorization newAuthorization: HomeAuthorizationIdentity
  ) {
    guard selection != newSelection || authorization != newAuthorization else {
      return
    }
    cancelArtwork()
    selection = newSelection
    authorization = newAuthorization
    startLoad(
      selection: newSelection,
      authorization: newAuthorization,
      preserving: nil
    )
  }

  func deactivate(_ expectedSelection: MovieDetailsSelection) {
    guard selection == expectedSelection else {
      return
    }
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
    selection = nil
    authorization = nil
    cancelArtwork()
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

  func play() -> MoviePlayIntent? {
    guard
      let details = confirmedDetails,
      details.playability == .playable,
      let defaultSource = details.defaultSource,
      defaultSource.isDefault,
      defaultSource.availability == .available
    else {
      return nil
    }
    return MoviePlayIntent(mediaIdentity: details.identity)
  }

  var confirmedDetails: MovieDetails? {
    switch state {
    case .content(let details), .refreshing(let details), .refreshFailed(let details, _):
      details

    case .idle, .loading, .catalogNotReady, .failed:
      nil
    }
  }

  private func startLoad(
    selection expectedSelection: MovieDetailsSelection,
    authorization expectedAuthorization: HomeAuthorizationIdentity,
    preserving details: MovieDetails?
  ) {
    activeTask?.cancel()
    attempt &+= 1
    let expectedAttempt = attempt
    state =
      details.map(MovieDetailsState.refreshing)
      ?? .loading(expectedSelection)
    let currentLoader = loader
    activeTask = Task { [weak self] in
      let result: Result<MovieDetails, any Error>
      do {
        result = .success(
          try await currentLoader.load(
            expectedSelection,
            authorization: expectedAuthorization
          )
        )
      } catch {
        result = .failure(error)
      }
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
    _ result: Result<MovieDetails, any Error>,
    preserving details: MovieDetails?,
    selection expectedSelection: MovieDetailsSelection,
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
      state = .content(replacement)

    case .failure(let error):
      let failure =
        (error as? MovieDetailsFailure)
        ?? .namaUnavailable(requestID: nil, retryAfterSeconds: nil)
      if details == nil,
        case .catalogNotReady(let retryAfterSeconds) = failure
      {
        state = .catalogNotReady(
          expectedSelection,
          retryAfterSeconds: retryAfterSeconds
        )
      } else {
        state =
          details.map { .refreshFailed($0, failure) }
          ?? .failed(expectedSelection, failure)
      }
    }
  }
}
