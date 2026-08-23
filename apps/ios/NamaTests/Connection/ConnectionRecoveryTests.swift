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

  @Test("Change Server prevents Retry while clearing the saved endpoint")
  func changeServerPreventsRetryDuringClear() async throws {
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
      let isEditing = feature.state == .editing(showsValidationError: false)
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
    #expect(feature.state == .editing(showsValidationError: false))
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
    VerifiedEndpointStoreSnapshot(endpoint: endpoint, generation: generation)
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
