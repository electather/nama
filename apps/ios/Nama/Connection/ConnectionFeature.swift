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
  @ObservationIgnored private var activeTask: Task<Void, Never>?
  @ObservationIgnored private var attempt = 0

  init(verifier: any ConnectionVerifying) {
    self.verifier = verifier
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

  private func cancelActiveAttempt() {
    activeTask?.cancel()
    activeTask = nil
    attempt &+= 1
  }
}
