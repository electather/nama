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

nonisolated enum HTTPConfirmationContext: Equatable, Sendable {
  case entry
  case restoration
}

nonisolated enum ConnectionState: Equatable, Sendable {
  case editing(validationError: EndpointValidationError?)
  case confirmingHTTP(NamaEndpoint, HTTPConfirmationContext)
  case verifying(NamaEndpoint)
  case ready(NamaEndpoint)
  case setupRequired(NamaEndpoint)
  case failed(NamaEndpoint, VerificationFailure)
  case pausedHTTPRestoration(NamaEndpoint)
  case requiresHTTPS(HTTPSRequiredEndpoint)
}

nonisolated private enum RestoredEndpointResolution: Sendable {
  case confirmation(NamaEndpoint, VerifiedEndpointStoreSnapshot)
  case verification(NamaEndpoint, ConnectionVerificationResult)
  case requiresHTTPS(HTTPSRequiredEndpoint)
}

@MainActor
@Observable
final class ConnectionFeature {
  var address = ""
  private(set) var state: ConnectionState = .editing(validationError: nil)
  var discoveryState: NamaDiscoveryState {
    discoverySession.state
  }

  @ObservationIgnored private let verifier: any ConnectionVerifying
  @ObservationIgnored private let endpointStore: any VerifiedEndpointStoring
  private let discoverySession: ConnectionDiscoverySession
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var restorationHandled = false
  @ObservationIgnored private var pendingRestorationSnapshot: VerifiedEndpointStoreSnapshot?

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

  #if DEBUG
    func setPreviewState(_ state: ConnectionState) {
      self.state = state
    }
  #endif

  deinit {
    activeTask?.cancel()
  }

  func submit() {
    let endpoint: NamaEndpoint
    do {
      endpoint = try NamaEndpoint(address)
    } catch {
      cancelActiveAttempt()
      state = .editing(
        validationError: (error as? EndpointValidationError) ?? .invalid
      )
      return
    }
    if endpoint.usesUnencryptedHTTP {
      enterHTTPConfirmation(for: endpoint, context: .entry)
    } else {
      startVerification(of: endpoint)
    }
  }

  func retry() {
    let endpoint: NamaEndpoint
    switch state {
    case .setupRequired(let value), .failed(let value, _):
      endpoint = value

    case .editing, .confirmingHTTP, .verifying, .ready, .pausedHTTPRestoration,
      .requiresHTTPS:
      return
    }
    startVerification(of: endpoint)
  }

  func continueWithoutHTTPS() {
    let endpoint: NamaEndpoint
    let restorationSnapshot: VerifiedEndpointStoreSnapshot?
    switch state {
    case .confirmingHTTP(let value, .entry):
      endpoint = value
      restorationSnapshot = nil

    case .confirmingHTTP(let value, .restoration),
      .pausedHTTPRestoration(let value):
      guard let snapshot = pendingRestorationSnapshot else {
        returnToEditing()
        return
      }
      endpoint = value
      restorationSnapshot = snapshot

    case .editing, .verifying, .ready, .setupRequired, .failed, .requiresHTTPS:
      return
    }
    startVerification(of: endpoint, from: restorationSnapshot)
  }

  func activateDiscovery() {
    discoverySession.activate()
  }

  func select(_ candidate: NamaDiscoveryCandidate) {
    address = candidate.endpoint.absoluteString
    if candidate.endpoint.usesUnencryptedHTTP {
      enterHTTPConfirmation(for: candidate.endpoint, context: .entry)
    } else {
      startVerification(of: candidate.endpoint)
    }
  }

  func addressDidChange() {
    let selectedEndpoint: NamaEndpoint?
    switch state {
    case .confirmingHTTP(let endpoint, .entry), .verifying(let endpoint):
      selectedEndpoint = endpoint

    case .editing, .confirmingHTTP, .ready, .setupRequired, .failed,
      .pausedHTTPRestoration, .requiresHTTPS:
      selectedEndpoint = nil
    }
    guard address != selectedEndpoint?.absoluteString else {
      return
    }
    returnToEditing()
  }

  func cancel() {
    switch state {
    case .confirmingHTTP(let endpoint, .restoration):
      state = .pausedHTTPRestoration(endpoint)

    case .editing, .confirmingHTTP, .verifying, .ready, .setupRequired, .failed,
      .pausedHTTPRestoration, .requiresHTTPS:
      returnToEditing()
    }
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
    pendingRestorationSnapshot = nil
    state = .editing(validationError: nil)
    await endpointStore.clear()
  }

  private func returnToEditing() {
    restorationHandled = true
    cancelActiveAttempt()
    pendingRestorationSnapshot = nil
    state = .editing(validationError: nil)
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
      guard let restoredEndpoint = snapshot.endpoint else {
        self?.finishInvalidatedAttempt(currentAttempt)
        return
      }
      if case .eligible(let endpoint) = restoredEndpoint,
        !endpoint.usesUnencryptedHTTP,
        self?.beginRestoredVerification(endpoint, attempt: currentAttempt) != true
      {
        return
      }
      let resolution = await resolveRestoredEndpoint(
        restoredEndpoint,
        from: snapshot,
        using: connectionVerifier,
        endpointStore: store
      )
      guard !Task.isCancelled else {
        return
      }
      self?.finishRestoration(resolution, attempt: currentAttempt)
    }
  }

  private func finishRestoration(
    _ resolution: RestoredEndpointResolution?,
    attempt currentAttempt: Int
  ) {
    guard let resolution else {
      finishInvalidatedAttempt(currentAttempt)
      return
    }
    switch resolution {
    case .confirmation(let endpoint, let snapshot):
      finishHTTPRestorationConfirmation(
        endpoint,
        snapshot: snapshot,
        attempt: currentAttempt
      )

    case .verification(let endpoint, let result):
      finishVerification(result, endpoint: endpoint, attempt: currentAttempt)

    case .requiresHTTPS(let endpoint):
      finishHTTPSRequiredRestoration(endpoint, attempt: currentAttempt)
    }
  }

  private func finishHTTPSRequiredRestoration(
    _ endpoint: HTTPSRequiredEndpoint,
    attempt currentAttempt: Int
  ) {
    guard isCurrentAttempt(currentAttempt) else {
      return
    }
    activeTask = nil
    state = .requiresHTTPS(endpoint)
  }

  private func finishHTTPRestorationConfirmation(
    _ endpoint: NamaEndpoint,
    snapshot: VerifiedEndpointStoreSnapshot,
    attempt currentAttempt: Int
  ) {
    guard isCurrentAttempt(currentAttempt) else {
      return
    }
    activeTask = nil
    pendingRestorationSnapshot = snapshot
    state = .confirmingHTTP(endpoint, .restoration)
  }

  private func enterHTTPConfirmation(
    for endpoint: NamaEndpoint,
    context: HTTPConfirmationContext
  ) {
    restorationHandled = true
    cancelActiveAttempt()
    pendingRestorationSnapshot = nil
    state = .confirmingHTTP(endpoint, context)
  }

  private func startVerification(
    of endpoint: NamaEndpoint,
    from restorationSnapshot: VerifiedEndpointStoreSnapshot? = nil
  ) {
    restorationHandled = true
    cancelActiveAttempt()
    pendingRestorationSnapshot = nil
    state = .verifying(endpoint)
    attempt &+= 1
    let currentAttempt = attempt
    let store = endpointStore
    let connectionVerifier = verifier

    activeTask = Task { [weak self] in
      let snapshot: VerifiedEndpointStoreSnapshot
      if let restorationSnapshot {
        guard await store.isCurrent(restorationSnapshot) else {
          self?.finishInvalidatedAttempt(currentAttempt)
          return
        }
        snapshot = restorationSnapshot
      } else {
        snapshot = await store.snapshot()
      }
      guard !Task.isCancelled, self?.isCurrentAttempt(currentAttempt) == true else {
        return
      }
      let result = await verifyEndpoint(
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

  private func finishVerification(
    _ result: ConnectionVerificationResult,
    endpoint: NamaEndpoint,
    attempt currentAttempt: Int
  ) {
    guard isCurrentAttempt(currentAttempt) else {
      return
    }
    activeTask = nil
    pendingRestorationSnapshot = nil

    switch result {
    case .ready:
      state = .ready(endpoint)

    case .setupRequired:
      state = .setupRequired(endpoint)

    case .failure(let failure):
      state = .failed(endpoint, failure)

    case .cancelled:
      state = .editing(validationError: nil)
    }
  }

  private func finishInvalidatedAttempt(_ currentAttempt: Int) {
    guard currentAttempt == attempt else {
      return
    }
    activeTask = nil
    state = .editing(validationError: nil)
  }

  private func cancelActiveAttempt() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}

nonisolated private func resolveRestoredEndpoint(
  _ restoredEndpoint: RestoredNamaEndpoint,
  from snapshot: VerifiedEndpointStoreSnapshot,
  using verifier: any ConnectionVerifying,
  endpointStore: any VerifiedEndpointStoring
) async -> RestoredEndpointResolution? {
  switch restoredEndpoint {
  case .eligible(let endpoint):
    if endpoint.usesUnencryptedHTTP {
      guard await endpointStore.isCurrent(snapshot) else {
        return nil
      }
      return .confirmation(endpoint, snapshot)
    }
    guard
      let result = await verifyEndpoint(
        endpoint,
        from: snapshot,
        using: verifier,
        endpointStore: endpointStore
      )
    else {
      return nil
    }
    return .verification(endpoint, result)

  case .requiresHTTPS(let endpoint):
    guard await endpointStore.isCurrent(snapshot) else {
      return nil
    }
    return .requiresHTTPS(endpoint)
  }
}

nonisolated private func verifyEndpoint(
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
