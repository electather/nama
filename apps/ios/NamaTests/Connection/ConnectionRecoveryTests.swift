import Testing

@testable import Nama

@Suite("Connection recovery")
struct ConnectionRecoveryTests {
  @Test("releasing the owning window cancels active verification")
  func releasingOwnerCancelsRequest() async {
    let verifier = CancellationVerifier()
    var feature: ConnectionFeature? = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    let releasedFeature = WeakReference(feature)
    feature?.address = "https://nama.example.com"
    feature?.submit()
    await eventually { await verifier.callCount == 1 }

    feature = nil
    await eventually { releasedFeature.value == nil }
    let released = releasedFeature.value == nil
    releasedFeature.value?.cancel()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(released)
    #expect(await verifier.cancellationCount == 1)
  }

  @Test("Change Endpoint prevents Retry while clearing the saved endpoint")
  func changeEndpointPreventsRetryDuringClear() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = SuspendingClearEndpointStore(endpoint: endpoint)
    let verifier = ManualVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.restoreSavedEndpoint()
    await eventually { await verifier.callCount == 1 }
    await verifier.resolve(call: 0, with: .failure(.namaUnavailable))
    await eventually { feature.state == .failed(endpoint, .namaUnavailable) }

    let changeTask = Task {
      await feature.changeEndpoint()
    }
    await eventually { await store.clearStarted }
    feature.retry()
    await eventually {
      let isEditing = feature.state == .editing(validationError: nil)
      let retried = await verifier.callCount > 1
      return isEditing || retried
    }
    let callCount = await verifier.callCount

    await store.finishClear()
    await changeTask.value
    if callCount > 1 {
      await verifier.resolve(call: 1, with: .ready)
      await eventually { await store.endpoint != nil }
    }

    #expect(callCount == 1)
    #expect(feature.state == .editing(validationError: nil))
    #expect(await store.endpoint == nil)
  }
}

@Suite("Verified endpoint restoration")
struct ConnectionRestorationTests {
  @Test("the owning window activates restoration only once")
  func restorationActivationIsExplicitAndIdempotent() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    await Task.yield()

    #expect(await verifier.callCount == 0)
    feature.restoreSavedEndpoint()
    feature.restoreSavedEndpoint()
    await eventually { feature.state == .ready(endpoint) }

    #expect(await verifier.callCount == 1)
  }

  @Test(
    "launch reverifies one saved endpoint into its verified status",
    arguments: [true, false]
  )
  func restoresSavedEndpoint(initialized: Bool) async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com/reverse-proxy")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let result: ConnectionVerificationResult = initialized ? .ready : .setupRequired
    let verifier = ImmediateVerifier(result: result)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.restoreSavedEndpoint()
    let expected: ConnectionState = initialized ? .ready(endpoint) : .setupRequired(endpoint)

    await eventually { feature.state == expected }

    #expect(feature.address.isEmpty)
    #expect(await verifier.callCount == 1)
  }

  @Test("canceling local HTTP restoration pauses the saved endpoint without a request")
  func cancelingLocalHTTPRestorationPausesEndpoint() async throws {
    let endpoint = try NamaEndpoint("http://192.168.1.20/reverse-proxy")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )

    feature.restoreSavedEndpoint()
    await eventually { feature.state == .confirmingHTTP(endpoint, .restoration) }

    #expect(await verifier.callCount == 0)
    feature.cancel()

    #expect(feature.state == .pausedHTTPRestoration(endpoint))
    #expect(feature.state.actions == [.continueWithoutHTTPS, .changeEndpoint])
    #expect(await verifier.callCount == 0)
    #expect(await store.endpoint == endpoint)
  }

  @Test("local HTTP acknowledgement survives restoration failure and Retry")
  func localHTTPAcknowledgementSurvivesRetry() async throws {
    let endpoint = try NamaEndpoint("http://nama.local")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ManualVerifier()
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )

    feature.restoreSavedEndpoint()
    await eventually { feature.state == .confirmingHTTP(endpoint, .restoration) }
    feature.cancel()
    feature.continueWithoutHTTPS()
    await eventually { await verifier.callCount == 1 }
    await verifier.resolve(call: 0, with: .failure(.cannotConnect))
    await eventually { feature.state == .failed(endpoint, .cannotConnect) }

    feature.retry()
    await eventually { await verifier.callCount == 2 }

    #expect(feature.state == .verifying(endpoint))
    await verifier.resolve(call: 1, with: .ready)
    await eventually { feature.state == .ready(endpoint) }
    #expect(await store.endpoint == endpoint)
  }

  @Test("legacy forbidden HTTP restoration stays visible and never reaches verification")
  func blocksLegacyForbiddenHTTP() async {
    let savedAddress = "http://nama.example.com/reverse-proxy/"
    let endpoint = HTTPSRequiredEndpoint(savedAddress)
    let store = InMemoryVerifiedEndpointStore(
      restoredEndpoint: .requiresHTTPS(endpoint)
    )
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )

    feature.restoreSavedEndpoint()
    await eventually { feature.state == .requiresHTTPS(endpoint) }

    #expect(feature.address.isEmpty)
    #expect(feature.state.actions == [.changeEndpoint])
    #expect(await verifier.callCount == 0)
    #expect(await store.snapshot().endpoint == .requiresHTTPS(endpoint))
  }

  @Test(
    "a safe restoration failure retains the saved endpoint",
    arguments: [
      VerificationFailure.namaUnavailable,
      VerificationFailure.cannotConnect,
      VerificationFailure.incompatible,
    ]
  )
  func restorationFailureRetainsEndpoint(failure: VerificationFailure) async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ImmediateVerifier(result: .failure(failure))
    let feature = ConnectionFeature(
      verifier: verifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    feature.restoreSavedEndpoint()

    await eventually { feature.state == .failed(endpoint, failure) }

    #expect(await verifier.callCount == 1)
    #expect(await store.endpoint == endpoint)
  }

  @Test("Change Endpoint cancels restoration and clears the saved endpoint")
  func changeEndpointClearsEndpoint() async throws {
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

    await feature.changeEndpoint()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(validationError: nil))
    #expect(await store.endpoint == nil)
  }

  @Test("Change Endpoint prevents another window from restoring the cleared endpoint")
  func changeEndpointInvalidatesOtherRestorations() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let clearingVerifier = CancellationVerifier()
    let staleVerifier = ManualVerifier()
    let clearingFeature = ConnectionFeature(
      verifier: clearingVerifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    let staleFeature = ConnectionFeature(
      verifier: staleVerifier,
      discovery: InactiveDiscovery(),
      endpointStore: store
    )
    clearingFeature.restoreSavedEndpoint()
    staleFeature.restoreSavedEndpoint()
    await eventually {
      let clearingStarted = await clearingVerifier.callCount == 1
      let staleStarted = await staleVerifier.callCount == 1
      return clearingStarted && staleStarted
    }

    await clearingFeature.changeEndpoint()
    await eventually { await clearingVerifier.cancellationCount == 1 }
    await staleVerifier.resolve(call: 0, with: .ready)
    await eventually {
      if case .verifying = staleFeature.state {
        return false
      }
      return true
    }

    #expect(staleFeature.state == .editing(validationError: nil))
    #expect(await store.endpoint == nil)
  }
}

private actor SuspendingClearEndpointStore: VerifiedEndpointStoring {
  private(set) var endpoint: NamaEndpoint?
  private var generation: UInt64 = 0
  private var clearContinuation: CheckedContinuation<Void, Never>?

  var clearStarted: Bool {
    clearContinuation != nil
  }

  init(endpoint: NamaEndpoint) {
    self.endpoint = endpoint
  }

  func snapshot() -> VerifiedEndpointStoreSnapshot {
    VerifiedEndpointStoreSnapshot(
      endpoint: endpoint.map(RestoredNamaEndpoint.eligible),
      generation: generation
    )
  }

  func save(
    _ endpoint: NamaEndpoint,
    ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
  ) -> Bool {
    guard snapshot.generation == generation else {
      return false
    }
    self.endpoint = endpoint
    return true
  }

  func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) -> Bool {
    snapshot.generation == generation
  }

  func clear() async {
    generation &+= 1
    endpoint = nil
    await withCheckedContinuation { continuation in
      clearContinuation = continuation
    }
  }

  func finishClear() {
    clearContinuation?.resume()
    clearContinuation = nil
  }
}

@MainActor
private final class WeakReference<Value: AnyObject> {
  weak var value: Value?

  init(_ value: Value?) {
    self.value = value
  }
}
