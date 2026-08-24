extension ConnectionFeature {
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
    beginConnectionFlow(for: endpoint)
  }

  func retry() {
    let endpoint: NamaEndpoint
    switch state {
    case .setupRequired(let value), .failed(let value, _):
      endpoint = value

    case .editing, .checkingHTTPAcknowledgement, .confirmingHTTP, .verifying,
      .ready, .pausedHTTPRestoration, .requiresHTTPS:
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

    case .editing, .checkingHTTPAcknowledgement, .verifying, .ready, .setupRequired,
      .failed, .requiresHTTPS:
      return
    }
    startVerification(of: endpoint, from: restorationSnapshot)
  }

  func activateDiscovery() {
    discoverySession.activate()
  }

  func select(_ candidate: NamaDiscoveryCandidate) {
    address = candidate.endpoint.absoluteString
    beginConnectionFlow(for: candidate.endpoint)
  }

  func addressDidChange() {
    let selectedEndpoint: NamaEndpoint?
    switch state {
    case .checkingHTTPAcknowledgement(let endpoint),
      .confirmingHTTP(let endpoint, .entry), .verifying(let endpoint):
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

    case .editing, .checkingHTTPAcknowledgement, .confirmingHTTP, .verifying,
      .ready, .setupRequired, .failed, .pausedHTTPRestoration, .requiresHTTPS:
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
        !endpoint.usesUnencryptedHTTP || snapshot.acknowledgesLocalHTTP(endpoint),
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

  private func beginConnectionFlow(for endpoint: NamaEndpoint) {
    guard endpoint.usesUnencryptedHTTP else {
      startVerification(of: endpoint)
      return
    }

    restorationHandled = true
    cancelActiveAttempt()
    pendingRestorationSnapshot = nil
    state = .checkingHTTPAcknowledgement(endpoint)
    attempt &+= 1
    let currentAttempt = attempt
    let store = endpointStore

    activeTask = Task { [weak self] in
      let snapshot = await store.snapshot()
      guard !Task.isCancelled else {
        return
      }
      self?.finishLocalHTTPAdmission(
        endpoint,
        snapshot: snapshot,
        attempt: currentAttempt
      )
    }
  }

  private func finishLocalHTTPAdmission(
    _ endpoint: NamaEndpoint,
    snapshot: VerifiedEndpointStoreSnapshot,
    attempt currentAttempt: Int
  ) {
    guard isCurrentAttempt(currentAttempt) else {
      return
    }
    activeTask = nil
    if snapshot.acknowledgesLocalHTTP(endpoint) {
      startVerification(of: endpoint, from: snapshot)
    } else {
      enterHTTPConfirmation(for: endpoint, context: .entry)
    }
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
