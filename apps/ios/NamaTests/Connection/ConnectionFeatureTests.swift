import Foundation
import Testing

@testable import Nama

@Suite("Connection verification state")
struct ConnectionFeatureTests {
  @Test("invalid input is preserved and reported only after submission")
  func invalidInput() async {
    let verifier = ImmediateVerifier(result: .ready)
    let store = InMemoryVerifiedEndpointStore()
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
    feature.address = "nama.example.com"

    #expect(feature.state == .editing(showsValidationError: false))
    feature.submit()

    #expect(feature.address == "nama.example.com")
    #expect(feature.state == .editing(showsValidationError: true))
    #expect(await verifier.callCount == 0)
    #expect(await store.endpoint == nil)
  }

  @Test(
    "a completed status persists the endpoint and becomes an honest terminal state",
    arguments: [true, false]
  )
  func terminalState(initialized: Bool) async throws {
    let result: ConnectionVerificationResult = initialized ? .ready : .setupRequired
    let verifier = ImmediateVerifier(result: result)
    let store = InMemoryVerifiedEndpointStore()
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
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
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.address = "https://other.example.com"
    feature.addressDidChange()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
  }

  @Test("leaving the flow cancels restoration without clearing the saved endpoint")
  func leavingFlowCancelsRequest() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
    feature.restoreSavedEndpoint()
    await eventually { await verifier.callCount == 1 }

    feature.flowDidLeave()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
    #expect(await store.endpoint == endpoint)
  }

  @Test("leaving the flow preserves a completed status")
  func leavingFlowPreservesTerminalState() async throws {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(
      verifier: verifier,
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
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
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
      endpointStore: InMemoryVerifiedEndpointStore()
    )
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.cancel()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
  }

  @Test("the owning window activates restoration only once")
  func restorationActivationIsExplicitAndIdempotent() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
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
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
    feature.restoreSavedEndpoint()
    let expected: ConnectionState = initialized ? .ready(endpoint) : .setupRequired(endpoint)

    await eventually { feature.state == expected }

    #expect(feature.address.isEmpty)
    #expect(await verifier.callCount == 1)
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
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
    feature.restoreSavedEndpoint()

    await eventually { feature.state == .failed(endpoint, failure) }

    #expect(await verifier.callCount == 1)
    #expect(await store.endpoint == endpoint)
  }

  @Test("Change Server cancels restoration and clears the saved endpoint")
  func changeServerClearsEndpoint() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(verifier: verifier, endpointStore: store)
    feature.restoreSavedEndpoint()
    await eventually { await verifier.callCount == 1 }

    await feature.changeEndpoint()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
    #expect(await store.endpoint == nil)
  }

  @Test("Change Server prevents another window from restoring the cleared endpoint")
  func changeServerInvalidatesOtherRestorations() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let store = InMemoryVerifiedEndpointStore(endpoint: endpoint)
    let clearingVerifier = CancellationVerifier()
    let staleVerifier = ManualVerifier()
    let clearingFeature = ConnectionFeature(
      verifier: clearingVerifier,
      endpointStore: store
    )
    let staleFeature = ConnectionFeature(
      verifier: staleVerifier,
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

    #expect(staleFeature.state == .editing(showsValidationError: false))
    #expect(await store.endpoint == nil)
  }
}

private actor ImmediateVerifier: ConnectionVerifying {
  private(set) var callCount = 0
  private let result: ConnectionVerificationResult

  init(result: ConnectionVerificationResult) {
    self.result = result
  }

  func verify(_: NamaEndpoint) -> ConnectionVerificationResult {
    callCount += 1
    return result
  }
}
