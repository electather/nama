import Foundation
import Testing

@testable import Nama

@Suite("Connection verification state")
struct ConnectionFeatureTests {
  @Test("invalid input is preserved and reported only after submission")
  func invalidInput() async {
    let verifier = ImmediateVerifier(result: .ready)
    let store = InMemoryVerifiedEndpointStore()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.address = "nama.example.com"

    #expect(feature.state == .editing(validationError: nil))
    feature.submit()

    #expect(feature.address == "nama.example.com")
    #expect(feature.state == .editing(validationError: .invalid))
    #expect(await verifier.callCount == 0)
    #expect(await store.endpoint == nil)
  }

  @Test("forbidden HTTP input stays editable and never reaches verification")
  func forbiddenHTTPInput() async {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "http://nama.example.com/reverse-proxy"

    feature.submit()

    #expect(feature.address == "http://nama.example.com/reverse-proxy")
    #expect(feature.state == .editing(validationError: .requiresHTTPS))
    #expect(await verifier.callCount == 0)
  }

  @Test("manual local HTTP asks before the verifier receives a request")
  func manualLocalHTTPRequiresConfirmation() async throws {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    let endpoint = try NamaEndpoint("http://192.168.1.20/reverse-proxy")
    feature.address = endpoint.absoluteString

    feature.submit()

    await eventually { feature.state == .confirmingHTTP(endpoint, .entry) }
    #expect(feature.state.actions == [.cancel, .continueWithoutHTTPS])
    #expect(await verifier.callCount == 0)

    feature.continueWithoutHTTPS()
    await eventually { feature.state == .ready(endpoint) }

    #expect(await verifier.callCount == 1)
  }

  @Test("canceling manual local HTTP returns to the populated editor without a request")
  func cancelingManualLocalHTTPReturnsToEditor() async throws {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    let enteredAddress = "http://192.168.1.20/a/very/long/reverse/proxy/path"
    let endpoint = try NamaEndpoint(enteredAddress)
    feature.address = enteredAddress

    feature.submit()
    await eventually { feature.state == .confirmingHTTP(endpoint, .entry) }
    feature.cancel()

    #expect(feature.address == enteredAddress)
    #expect(feature.state == .editing(validationError: nil))
    #expect(await verifier.callCount == 0)
  }

  @Test(
    "a completed status persists the endpoint and becomes an honest terminal state",
    arguments: [true, false]
  )
  func terminalState(initialized: Bool) async throws {
    let result: ConnectionVerificationResult = initialized ? .ready : .setupRequired
    let verifier = ImmediateVerifier(result: result)
    let store = InMemoryVerifiedEndpointStore()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let expected: ConnectionState = initialized ? .ready(endpoint) : .setupRequired(endpoint)
    feature.address = endpoint.absoluteString

    feature.submit()
    await eventually { feature.state == expected }

    #expect(await verifier.callCount == 1)
    #expect(await store.endpoint == endpoint)
  }

  @Test("editing the address cancels an active request")
  func editingCancelsRequest() async {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.address = "https://other.example.com"
    feature.addressDidChange()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(validationError: nil))
  }

  @Test("leaving the flow cancels restoration without clearing the saved endpoint")
  func leavingFlowCancelsRequest() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.restoreSavedEndpoint()
    await eventually { await verifier.callCount == 1 }

    feature.flowDidLeave()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(validationError: nil))
    #expect(await store.endpoint == endpoint)
  }

  @Test("leaving the flow preserves a completed status")
  func leavingFlowPreservesTerminalState() async throws {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    let endpoint = try NamaEndpoint("https://nama.example.com")
    feature.address = endpoint.absoluteString
    feature.submit()
    await eventually { feature.state == .ready(endpoint) }

    feature.flowDidLeave()

    #expect(feature.state == .ready(endpoint))
  }

  @Test("submitting another endpoint replaces the active request")
  func submittingAgainCancelsRequest() async throws {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://first.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.address = "https://second.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 2 }

    #expect(await verifier.cancellationCount == 1)
    #expect(feature.state == .verifying(try NamaEndpoint("https://second.example.com")))
    feature.cancel()
  }

  @Test("a canceled stale response cannot replace a newer terminal state")
  func staleResponseIsIgnored() async throws {
    let verifier = ManualVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://first.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.address = "https://second.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 2 }
    let expectedEndpoint = try NamaEndpoint("https://second.example.com")
    await verifier.resolve(call: 1, with: .setupRequired)
    await eventually {
      feature.state == .setupRequired(expectedEndpoint)
    }

    await verifier.resolve(call: 0, with: .ready)
    await Task.yield()

    #expect(feature.state == .setupRequired(expectedEndpoint))
  }

  @Test("Retry starts one fresh restoration attempt without an automatic loop")
  func retryIsExplicit() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ImmediateVerifier(result: .failure(.namaUnavailable))
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.restoreSavedEndpoint()
    await eventually { feature.state == .failed(endpoint, .namaUnavailable) }

    #expect(await verifier.callCount == 1)
    feature.retry()
    await eventually { await verifier.callCount == 2 }
    await Task.yield()

    #expect(await verifier.callCount == 2)
    #expect(await store.endpoint == endpoint)
  }

  @Test("Cancel ends the active attempt without presenting a failure")
  func explicitCancel() async {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.cancel()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(validationError: nil))
  }
}

@Suite("Connection HTTP acknowledgement state")
struct ConnectionHTTPAcknowledgementTests {
  @Test("selected local HTTP remains visible while acknowledgement loads")
  func selectedLocalHTTPRemainsVisibleDuringAcknowledgementLookup() async throws {
    let store = SuspendingSnapshotEndpointStore()
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    let endpoint = try NamaEndpoint("http://nama.local")
    feature.address = endpoint.absoluteString

    feature.submit()
    await eventually { await store.snapshotStarted }

    #expect(feature.state.showsUnencryptedHTTPWarning)
    #expect(feature.state.actions == [.connect, .cancel, .changeEndpoint])
    #expect(await verifier.callCount == 0)
    await store.finishSnapshot()
    await eventually {
      feature.state == .confirmingHTTP(endpoint, .entry)
    }
  }

  @Test("a successful local HTTP acknowledgement is shared across windows")
  func sharesSuccessfulLocalHTTPAcknowledgementAcrossWindows() async throws {
    let suiteName = "NamaTests.ConnectionFeature.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let endpoint = try NamaEndpoint("http://nama.local/reverse-proxy")
    let firstVerifier = ImmediateVerifier(result: .ready)
    let firstFeature = ConnectionFeature(
      verifier: firstVerifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    firstFeature.address = endpoint.absoluteString
    firstFeature.submit()
    await eventually {
      firstFeature.state == .confirmingHTTP(endpoint, .entry)
    }
    firstFeature.continueWithoutHTTPS()
    await eventually { firstFeature.state == .ready(endpoint) }

    let secondVerifier = ImmediateVerifier(result: .ready)
    let secondFeature = ConnectionFeature(
      verifier: secondVerifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    secondFeature.address = endpoint.absoluteString
    secondFeature.submit()
    await eventually { secondFeature.state == .ready(endpoint) }

    #expect(await firstVerifier.callCount == 1)
    #expect(await secondVerifier.callCount == 1)
  }

  @Test("acknowledged local HTTP restoration remains visible while verifying")
  func acknowledgedLocalHTTPRestorationShowsVerification() async throws {
    let endpoint = try NamaEndpoint("http://nama.local")
    let store = InMemoryVerifiedEndpointStore()
    #expect(
      await store.save(
        endpoint,
        ifUnchangedSince: store.snapshot()
      )
    )
    let verifier = ManualVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )

    feature.restoreSavedEndpoint()
    await eventually { await verifier.callCount == 1 }

    #expect(feature.state == .verifying(endpoint))
    #expect(feature.state.showsUnencryptedHTTPWarning)
    await verifier.resolve(call: 0, with: .cancelled)
    await eventually {
      feature.state == .editing(validationError: nil)
    }
  }
}

private actor SuspendingSnapshotEndpointStore: VerifiedEndpointStoring {
  private var generation: UInt64 = 0
  private var continuation: CheckedContinuation<VerifiedEndpointStoreSnapshot, Never>?

  var snapshotStarted: Bool {
    continuation != nil
  }

  func snapshot() async -> VerifiedEndpointStoreSnapshot {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func save(
    _: NamaEndpoint,
    ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
  ) -> Bool {
    snapshot.generation == generation
  }

  func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) -> Bool {
    snapshot.generation == generation
  }

  func clear() {
    generation &+= 1
  }

  func finishSnapshot() {
    continuation?.resume(
      returning: VerifiedEndpointStoreSnapshot(
        endpoint: nil,
        generation: generation
      )
    )
    continuation = nil
  }
}
