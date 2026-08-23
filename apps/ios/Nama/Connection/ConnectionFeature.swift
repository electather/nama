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

  @ObservationIgnored private let verifier: any ConnectionVerifying
  @ObservationIgnored private let endpointStore: any VerifiedEndpointStoring
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0
  @ObservationIgnored private var restorationHandled = false

  init(
    verifier: any ConnectionVerifying,
    endpointStore: any VerifiedEndpointStoring
  ) {
    self.verifier = verifier
    self.endpointStore = endpointStore
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

  func addressDidChange() {
    returnToEditing()
  }

  func cancel() {
    returnToEditing()
  }

  func flowDidLeave() {
    guard activeTask != nil else {
      return
    }
    returnToEditing()
  }

  func changeEndpoint() async {
    restorationHandled = true
    cancelActiveAttempt()
    await endpointStore.clear()
    state = .editing(showsValidationError: false)
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

    activeTask = Task { [weak self] in
      guard let self else {
        return
      }
      let snapshot = await endpointStore.snapshot()
      guard currentAttempt == attempt, !Task.isCancelled else {
        return
      }
      guard let endpoint = snapshot.endpoint else {
        activeTask = nil
        return
      }
      state = .verifying(endpoint)
      await verify(endpoint, from: snapshot, attempt: currentAttempt)
    }
  }

  private func startVerification(of endpoint: NamaEndpoint) {
    restorationHandled = true
    cancelActiveAttempt()
    state = .verifying(endpoint)
    attempt &+= 1
    let currentAttempt = attempt

    activeTask = Task { [weak self] in
      guard let self else {
        return
      }
      let snapshot = await endpointStore.snapshot()
      guard currentAttempt == attempt, !Task.isCancelled else {
        return
      }
      await verify(endpoint, from: snapshot, attempt: currentAttempt)
    }
  }

  private func verify(
    _ endpoint: NamaEndpoint,
    from snapshot: VerifiedEndpointStoreSnapshot,
    attempt currentAttempt: Int
  ) async {
    let result = await verifier.verify(endpoint)
    guard currentAttempt == attempt, !Task.isCancelled else {
      return
    }

    switch result {
    case .ready:
      let saved = await endpointStore.save(endpoint, ifUnchangedSince: snapshot)
      guard saved, currentAttempt == attempt, !Task.isCancelled else {
        finishInvalidatedAttempt(currentAttempt)
        return
      }
      activeTask = nil
      state = .ready(endpoint)

    case .setupRequired:
      let saved = await endpointStore.save(endpoint, ifUnchangedSince: snapshot)
      guard saved, currentAttempt == attempt, !Task.isCancelled else {
        finishInvalidatedAttempt(currentAttempt)
        return
      }
      activeTask = nil
      state = .setupRequired(endpoint)

    case .failure(let failure):
      let isCurrent = await endpointStore.isCurrent(snapshot)
      guard isCurrent, currentAttempt == attempt, !Task.isCancelled else {
        finishInvalidatedAttempt(currentAttempt)
        return
      }
      activeTask = nil
      state = .failed(endpoint, failure)

    case .cancelled:
      activeTask = nil
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
