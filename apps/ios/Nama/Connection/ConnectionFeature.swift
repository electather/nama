import Observation

@MainActor
@Observable
final class ConnectionFeature {
  var address = ""
  var state: ConnectionState = .editing(validationError: nil)
  var discoveryState: NamaDiscoveryState {
    discoverySession.state
  }

  @ObservationIgnored let verifier: any ConnectionVerifying
  @ObservationIgnored let endpointStore: any VerifiedEndpointStoring
  let discoverySession: ConnectionDiscoverySession
  @ObservationIgnored var activeTask: Task<Void, Never>?
  @ObservationIgnored var attempt = 0
  @ObservationIgnored var restorationHandled = false
  @ObservationIgnored var pendingRestorationSnapshot: VerifiedEndpointStoreSnapshot?

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
}
