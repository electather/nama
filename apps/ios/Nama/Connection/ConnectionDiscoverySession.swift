import Observation

@MainActor
@Observable
final class ConnectionDiscoverySession {
  private static let emptyStateDelaySeconds = 2
  private static let emptyStateDelay = Duration.seconds(emptyStateDelaySeconds)

  private(set) var state: NamaDiscoveryState = .inactive

  @ObservationIgnored private let discovery: any NamaDiscovering
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private var discoveryTask: Task<Void, Never>?
  @ObservationIgnored private var emptyStateTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var activated = false
  @ObservationIgnored private var isSurfaceActive = false

  init(
    discovery: any NamaDiscovering,
    sleep: @escaping @Sendable (Duration) async throws -> Void
  ) {
    self.discovery = discovery
    self.sleep = sleep
  }

  deinit {
    discoveryTask?.cancel()
    emptyStateTask?.cancel()
  }

  func activate() {
    activated = true
    if case .failed = state {
      stop()
    }
    startIfNeeded()
  }

  func surfaceDidEnter() {
    isSurfaceActive = true
    startIfNeeded()
  }

  func surfaceDidLeave() {
    isSurfaceActive = false
    stop()
  }

  private func startIfNeeded() {
    guard activated, isSurfaceActive, discoveryTask == nil else {
      return
    }

    attempt &+= 1
    let currentAttempt = attempt
    let endpointDiscovery = discovery
    state = .scanning
    scheduleInitialEmptyState(for: currentAttempt)

    discoveryTask = Task { [weak self] in
      let events = await endpointDiscovery.browse()
      for await event in events {
        guard let self, currentAttempt == attempt, !Task.isCancelled else {
          return
        }
        receive(event)
      }

      guard let self, currentAttempt == attempt, !Task.isCancelled else {
        return
      }
      discoveryTask = nil
    }
  }

  private func scheduleInitialEmptyState(for currentAttempt: Int) {
    emptyStateTask?.cancel()
    let delay = sleep
    emptyStateTask = Task { [weak self] in
      do {
        try await delay(Self.emptyStateDelay)
      } catch {
        return
      }

      guard let self, currentAttempt == attempt, !Task.isCancelled else {
        return
      }
      emptyStateTask = nil
      if case .scanning = state {
        state = .empty
      }
    }
  }

  private func receive(_ event: NamaDiscoveryEvent) {
    switch event {
    case .records(let records):
      let candidates = NamaDiscoveryCandidate.reconcile(records)
      if candidates.isEmpty {
        receiveEmptyResults()
      } else {
        emptyStateTask?.cancel()
        emptyStateTask = nil
        state = .candidates(candidates)
      }

    case .failed(.permissionDenied):
      emptyStateTask?.cancel()
      emptyStateTask = nil
      state = .permissionDenied

    case .failed(.unavailable):
      emptyStateTask?.cancel()
      emptyStateTask = nil
      state = .failed
    }
  }

  private func receiveEmptyResults() {
    if case .candidates = state {
      state = .empty
    }
  }

  private func stop() {
    attempt &+= 1
    discoveryTask?.cancel()
    discoveryTask = nil
    emptyStateTask?.cancel()
    emptyStateTask = nil
    state = .inactive
  }
}
