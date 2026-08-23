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
  var address = ""
  private(set) var state: ConnectionState = .editing(showsValidationError: false)
  var discoveryState: NamaDiscoveryState {
    discoverySession.state
  }

  @ObservationIgnored private let verifier: any ConnectionVerifying
  @ObservationIgnored private let endpointStore: any VerifiedEndpointStoring
  private let discoverySession: ConnectionDiscoverySession
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var restorationHandled = false

  init(
    verifier: any ConnectionVerifying,
    discovery: any NamaDiscovering,
    endpointStore: any VerifiedEndpointStoring,
    sleep: @escaping @Sendable (Duration) async throws -> Void = { duration in
      try await Task.sleep(for: duration)
    }
  ) {
    self.verifier = verifier
    self.endpointStore = endpointStore
    discoverySession = ConnectionDiscoverySession(discovery: discovery, sleep: sleep)
  }

  deinit {
    activeTask?.cancel()
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
    discoverySession.activate()
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
    discoverySession.surfaceDidEnter()
  }

  func flowDidLeave() {
    discoverySession.surfaceDidLeave()
    guard activeTask != nil else {
      return
    }
    returnToEditing()
  }

  func changeEndpoint() async {
    restorationHandled = true
    cancelActiveAttempt()
    state = .editing(showsValidationError: false)
    await endpointStore.clear()
  }

  private func returnToEditing() {
    restorationHandled = true
    cancelActiveAttempt()
    state = .editing(showsValidationError: false)
  }

  func restoreSavedEndpoint() {
    guard !restorationHandled else {
      return
    }
    restorationHandled = true
    cancelActiveAttempt()
    attempt &+= 1
    let currentAttempt = attempt
    let store = endpointStore
    let connectionVerifier = verifier

    activeTask = Task { [weak self] in
      let snapshot = await store.snapshot()
      guard !Task.isCancelled else {
        return
      }
      guard let endpoint = snapshot.endpoint else {
        self?.finishInvalidatedAttempt(currentAttempt)
        return
      }
      guard self?.beginRestoredVerification(endpoint, attempt: currentAttempt) == true else {
        return
      }
      let result = await Self.verify(
        endpoint,
        from: snapshot,
        using: connectionVerifier,
        endpointStore: store
      )
      guard !Task.isCancelled else {
        return
      }
      guard let result else {
        self?.finishInvalidatedAttempt(currentAttempt)
        return
      }
      self?.finishVerification(result, endpoint: endpoint, attempt: currentAttempt)
    }
  }

  private func startVerification(of endpoint: NamaEndpoint) {
    restorationHandled = true
    cancelActiveAttempt()
    state = .verifying(endpoint)
    attempt &+= 1
    let currentAttempt = attempt
    let store = endpointStore
    let connectionVerifier = verifier

    activeTask = Task { [weak self] in
      let snapshot = await store.snapshot()
      guard !Task.isCancelled, self?.isCurrentAttempt(currentAttempt) == true else {
        return
      }
      let result = await Self.verify(
        endpoint,
        from: snapshot,
        using: connectionVerifier,
        endpointStore: store
      )
      guard !Task.isCancelled else {
        return
      }
      guard let result else {
        self?.finishInvalidatedAttempt(currentAttempt)
        return
      }
      self?.finishVerification(result, endpoint: endpoint, attempt: currentAttempt)
    }
  }

  private func beginRestoredVerification(
    _ endpoint: NamaEndpoint,
    attempt currentAttempt: Int
  ) -> Bool {
    guard isCurrentAttempt(currentAttempt) else {
      return false
    }
    state = .verifying(endpoint)
    return true
  }

  private func isCurrentAttempt(_ currentAttempt: Int) -> Bool {
    currentAttempt == attempt
  }

  nonisolated private static func verify(
    _ endpoint: NamaEndpoint,
    from snapshot: VerifiedEndpointStoreSnapshot,
    using verifier: any ConnectionVerifying,
    endpointStore: any VerifiedEndpointStoring
  ) async -> ConnectionVerificationResult? {
    let result = await verifier.verify(endpoint)
    guard !Task.isCancelled else {
      return nil
    }

    switch result {
    case .ready, .setupRequired:
      guard await endpointStore.save(endpoint, ifUnchangedSince: snapshot) else {
        return nil
      }
      return result

    case .failure:
      guard await endpointStore.isCurrent(snapshot) else {
        return nil
      }
      return result

    case .cancelled:
      return result
    }
  }

  private func finishVerification(
    _ result: ConnectionVerificationResult,
    endpoint: NamaEndpoint,
    attempt currentAttempt: Int
  ) {
    guard isCurrentAttempt(currentAttempt) else {
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

  private func finishInvalidatedAttempt(_ currentAttempt: Int) {
    guard currentAttempt == attempt else {
      return
    }
    activeTask = nil
    state = .editing(showsValidationError: false)
  }

  private func cancelActiveAttempt() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
