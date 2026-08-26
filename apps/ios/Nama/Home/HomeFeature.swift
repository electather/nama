import Observation

@MainActor
@Observable
final class HomeFeature {
  private(set) var state: HomeState = .loading

  @ObservationIgnored private let loader: any HomeLoading
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var authorization: HomeAuthorizationIdentity?
  @ObservationIgnored private var attempt: UInt64 = 0

  init(loader: any HomeLoading) {
    self.loader = loader
  }

  deinit {
    activeTask?.cancel()
  }

  func activate(_ authorization: HomeAuthorizationIdentity) {
    guard self.authorization != authorization else {
      return
    }
    self.authorization = authorization
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
    state = .loading
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
    guard let authorization else {
      return
    }
    cancelActiveLoad()
    attempt &+= 1
    let currentAttempt = attempt
    state = snapshot.map(HomeState.refreshing) ?? .loading
    let loader = self.loader

    activeTask = Task { [weak self] in
      let result: Result<HomeSnapshot, any Error>
      do {
        result = .success(try await loader.load(for: authorization))
      } catch {
        result = .failure(error)
      }
      guard !Task.isCancelled else {
        return
      }
      self?.finish(
        result,
        authorization: authorization,
        attempt: currentAttempt
      )
    }
  }

  private func finish(
    _ result: Result<HomeSnapshot, any Error>,
    authorization: HomeAuthorizationIdentity,
    attempt currentAttempt: UInt64
  ) {
    guard
      self.authorization == authorization,
      attempt == currentAttempt
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
