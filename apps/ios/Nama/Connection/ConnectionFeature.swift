import Observation

nonisolated enum VerificationFailure: Equatable, Sendable {
  case namaUnavailable
  case cannotConnect
  case incompatible
}

nonisolated enum ConnectionVerificationResult: Equatable, Sendable {
  case ready
  case setupRequired
  case failure(VerificationFailure)
  case cancelled
}

nonisolated protocol ConnectionVerifying: Sendable {
  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult
}

nonisolated enum ConnectionState: Equatable, Sendable {
  case editing(showsValidationError: Bool)
  case verifying(NamaEndpoint)
  case ready(NamaEndpoint)
  case setupRequired(NamaEndpoint)
  case failed(NamaEndpoint, VerificationFailure)
}

@MainActor
@Observable
final class ConnectionFeature {
  private static let discoveryEmptyStateDelaySeconds = 2
  private static let discoveryEmptyStateDelay = Duration.seconds(discoveryEmptyStateDelaySeconds)

  var address = ""
  private(set) var state: ConnectionState = .editing(showsValidationError: false)
  private(set) var discoveryState: NamaDiscoveryState = .inactive

  @ObservationIgnored private let verifier: any ConnectionVerifying
  @ObservationIgnored private let discovery: any NamaDiscovering
  @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var discoveryTask: Task<Void, Never>?
  @ObservationIgnored private var emptyStateTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var discoveryAttempt = 0
  @ObservationIgnored private var discoveryActivated = false
  @ObservationIgnored private var isSurfaceActive = false

  init(
    verifier: any ConnectionVerifying,
    discovery: any NamaDiscovering,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    self.verifier = verifier
    self.discovery = discovery
    self.sleep = sleep
  }

  func submit() {
    let endpoint: NamaEndpoint
    do {
      endpoint = try NamaEndpoint(address)
    } catch {
      cancelActiveAttempt()
      state = .editing(showsValidationError: true)
      return
    }
    startVerification(of: endpoint)
  }

  func retry() {
    let endpoint: NamaEndpoint
    switch state {
    case .setupRequired(let value), .failed(let value, _):
      endpoint = value

    case .editing, .verifying, .ready:
      return
    }
    startVerification(of: endpoint)
  }

  func activateDiscovery() {
    discoveryActivated = true
    if case .failed = discoveryState {
      stopDiscovery()
    }
    startDiscoveryIfNeeded()
  }

  func select(_ candidate: NamaDiscoveryCandidate) {
    address = candidate.endpoint.absoluteString
    startVerification(of: candidate.endpoint)
  }

  func addressDidChange() {
    if case .verifying(let endpoint) = state, address == endpoint.absoluteString {
      return
    }
    returnToEditing()
  }

  func cancel() {
    returnToEditing()
  }

  func flowDidEnter() {
    isSurfaceActive = true
    startDiscoveryIfNeeded()
  }

  func flowDidLeave() {
    isSurfaceActive = false
    stopDiscovery()
    guard case .verifying = state else {
      return
    }
    returnToEditing()
  }

  func changeEndpoint() {
    returnToEditing()
  }

  private func returnToEditing() {
    cancelActiveAttempt()
    state = .editing(showsValidationError: false)
  }

  private func startVerification(of endpoint: NamaEndpoint) {
    cancelActiveAttempt()
    state = .verifying(endpoint)
    attempt &+= 1
    let currentAttempt = attempt
    let connectionVerifier = verifier

    activeTask = Task { [weak self] in
      let result = await connectionVerifier.verify(endpoint)
      guard let self, currentAttempt == attempt, !Task.isCancelled else {
        return
      }
      activeTask = nil
      switch result {
      case .ready:
        state = .ready(endpoint)

      case .setupRequired:
        state = .setupRequired(endpoint)

      case .failure(let failure):
        state = .failed(endpoint, failure)

      case .cancelled:
        state = .editing(showsValidationError: false)
      }
    }
  }

  private func startDiscoveryIfNeeded() {
    guard discoveryActivated, isSurfaceActive, discoveryTask == nil else {
      return
    }

    discoveryAttempt &+= 1
    let currentAttempt = discoveryAttempt
    let endpointDiscovery = discovery
    discoveryState = .scanning
    scheduleInitialEmptyState(for: currentAttempt)

    discoveryTask = Task { [weak self] in
      let events = await endpointDiscovery.browse()
      for await event in events {
        guard let self, currentAttempt == discoveryAttempt, !Task.isCancelled else {
          return
        }
        receiveDiscoveryEvent(event)
      }

      guard let self, currentAttempt == discoveryAttempt, !Task.isCancelled else {
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
        try await delay(Self.discoveryEmptyStateDelay)
      } catch {
        return
      }

      guard let self, currentAttempt == discoveryAttempt, !Task.isCancelled else {
        return
      }
      emptyStateTask = nil
      if case .scanning = discoveryState {
        discoveryState = .empty
      }
    }
  }

  private func receiveDiscoveryEvent(_ event: NamaDiscoveryEvent) {
    switch event {
    case .records(let records):
      let candidates = NamaDiscoveryCandidate.reconcile(records)
      if !candidates.isEmpty {
        emptyStateTask?.cancel()
        emptyStateTask = nil
        discoveryState = .candidates(candidates)
      } else {
        receiveEmptyDiscoveryResults()
      }

    case .failed(.permissionDenied):
      emptyStateTask?.cancel()
      emptyStateTask = nil
      discoveryState = .permissionDenied

    case .failed(.unavailable):
      emptyStateTask?.cancel()
      emptyStateTask = nil
      discoveryState = .failed
    }
  }

  private func receiveEmptyDiscoveryResults() {
    switch discoveryState {
    case .candidates:
      discoveryState = .empty

    case .empty, .scanning:
      break

    case .inactive, .permissionDenied, .failed:
      break
    }
  }

  private func stopDiscovery() {
    discoveryAttempt &+= 1
    discoveryTask?.cancel()
    discoveryTask = nil
    emptyStateTask?.cancel()
    emptyStateTask = nil
    discoveryState = .inactive
  }

  private func cancelActiveAttempt() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
