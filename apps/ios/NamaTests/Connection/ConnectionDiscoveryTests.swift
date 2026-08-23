import Foundation
import Testing

@testable import Nama

@Suite("Connection discovery state")
struct ConnectionDiscoveryTests {
  @Test("explicit activation browses only while the connection surface is foregrounded")
  func foregroundLifecycle() async {
    let discovery = ManualDiscovery()
    let verifier = RecordingVerifier(result: .ready)
    let feature = makeFeature(verifier: verifier, discovery: discovery)

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }

    feature.flowDidLeave()
    await eventually { await discovery.cancellationCount == 1 }
    #expect(feature.discoveryState == .inactive)

    feature.flowDidEnter()
    await eventually { await discovery.browseCount == 2 }
    #expect(feature.discoveryState == .scanning)

    feature.flowDidLeave()
  }

  @Test("a sole result is never contacted or selected automatically")
  func selectionIsExplicit() async throws {
    let discovery = ManualDiscovery()
    let verifier = RecordingVerifier(result: .ready)
    let feature = makeFeature(verifier: verifier, discovery: discovery)
    let record = try discoveryRecord("https://nama.example.com", serviceName: "Nama")

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.records([record]))
    await eventually {
      feature.discoveryState == .candidates(NamaDiscoveryCandidate.reconcile([record]))
    }

    #expect(await verifier.endpoints.isEmpty)
    let candidate = try #require(discoveryCandidates(in: feature.discoveryState).first)
    feature.select(candidate)
    await eventually { await verifier.endpoints == [record.endpoint] }
    await eventually { feature.state == .ready(record.endpoint) }

    feature.flowDidLeave()
  }

  @Test("requests the approved scanning delay before presenting an initial empty state")
  func scanningDelay() async {
    let discovery = ManualDiscovery()
    let sleeper = ManualSleeper()
    let feature = makeFeature(
      verifier: RecordingVerifier(result: .ready),
      discovery: discovery,
      sleeper: sleeper
    )

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await sleeper.requestedDurations == [.seconds(2)] }

    #expect(feature.discoveryState == .scanning)
    await sleeper.releaseFirst()
    await eventually { feature.discoveryState == .empty }

    feature.flowDidLeave()
  }

  @Test("later results appear immediately and final removal returns directly to empty")
  func resultsAndRemovalAreImmediate() async throws {
    let discovery = ManualDiscovery()
    let sleeper = ManualSleeper()
    let feature = makeFeature(
      verifier: RecordingVerifier(result: .ready),
      discovery: discovery,
      sleeper: sleeper
    )
    let record = try discoveryRecord("https://nama.example.com", serviceName: "Nama")
    let expectedCandidates = NamaDiscoveryCandidate.reconcile([record])

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.records([record]))
    await eventually { feature.discoveryState == .candidates(expectedCandidates) }

    await discovery.send(.records([]))
    await eventually { feature.discoveryState == .empty }

    feature.flowDidLeave()
  }

  @Test("keeps a candidate until its final duplicate browse record disappears")
  func partialDuplicateRemoval() async throws {
    let discovery = ManualDiscovery()
    let feature = makeFeature(
      verifier: RecordingVerifier(result: .ready),
      discovery: discovery
    )
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let firstRecord = NamaDiscoveryRecord(endpoint: endpoint, serviceName: "First")
    let secondRecord = NamaDiscoveryRecord(endpoint: endpoint, serviceName: "Second")

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.records([firstRecord, secondRecord]))
    await eventually {
      discoveryCandidates(in: feature.discoveryState).first?.serviceNames == ["First", "Second"]
    }

    await discovery.send(.records([firstRecord]))
    await eventually {
      discoveryCandidates(in: feature.discoveryState).first?.serviceNames == ["First"]
    }

    await discovery.send(.records([]))
    await eventually { feature.discoveryState == .empty }

    feature.flowDidLeave()
  }

  @Test("advertisement removal does not cancel selected endpoint verification")
  func removalPreservesVerification() async throws {
    let discovery = ManualDiscovery()
    let verifier = SuspendingVerifier()
    let feature = makeFeature(verifier: verifier, discovery: discovery)
    let record = try discoveryRecord("https://nama.example.com", serviceName: "Nama")

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.records([record]))
    await eventually { discoveryCandidates(in: feature.discoveryState).count == 1 }
    let candidate = try #require(discoveryCandidates(in: feature.discoveryState).first)

    feature.select(candidate)
    await eventually { await verifier.callCount == 1 }
    await discovery.send(.records([]))
    await eventually { feature.discoveryState == .empty }

    #expect(feature.state == .verifying(record.endpoint))
    await verifier.resolve(call: 0, with: .ready)
    await eventually { feature.state == .ready(record.endpoint) }

    feature.flowDidLeave()
  }

  @Test("selecting another candidate cancels and replaces active verification")
  func replacingSelectionCancelsVerification() async throws {
    let discovery = ManualDiscovery()
    let verifier = CancellationRecordingVerifier()
    let feature = makeFeature(verifier: verifier, discovery: discovery)
    let first = try discoveryRecord("https://first.example.com", serviceName: "First")
    let second = try discoveryRecord("https://second.example.com", serviceName: "Second")

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.records([first, second]))
    await eventually { discoveryCandidates(in: feature.discoveryState).count == 2 }
    let candidates = discoveryCandidates(in: feature.discoveryState)

    feature.select(candidates[0])
    await eventually { await verifier.endpoints.count == 1 }
    feature.select(candidates[1])
    await eventually { await verifier.endpoints.count == 2 }
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .verifying(second.endpoint))
    feature.cancel()
    feature.flowDidLeave()
  }

  @Test("permission and browser failures preserve manual endpoint verification")
  func failuresKeepManualFallback() async throws {
    let discovery = ManualDiscovery()
    let verifier = RecordingVerifier(result: .setupRequired)
    let feature = makeFeature(verifier: verifier, discovery: discovery)
    let endpoint = try NamaEndpoint("https://manual.example.com")

    feature.flowDidEnter()
    feature.activateDiscovery()
    await eventually { await discovery.browseCount == 1 }
    await discovery.send(.failed(.permissionDenied))
    await eventually { feature.discoveryState == .permissionDenied }

    await discovery.send(.failed(.unavailable))
    await eventually { feature.discoveryState == .failed }
    feature.address = endpoint.absoluteString
    feature.submit()
    await eventually { await verifier.endpoints == [endpoint] }
    await eventually { feature.state == .setupRequired(endpoint) }

    feature.flowDidLeave()
  }
}

@MainActor
private func makeFeature(
  verifier: any ConnectionVerifying,
  discovery: any NamaDiscovering,
  sleeper: ManualSleeper = ManualSleeper()
) -> ConnectionFeature {
  ConnectionFeature(
    verifier: verifier,
    discovery: discovery,
    endpointStore: InMemoryVerifiedEndpointStore()
  ) { duration in
    try await sleeper.sleep(for: duration)
  }
}

private func discoveryRecord(
  _ endpoint: String,
  serviceName: String
) throws -> NamaDiscoveryRecord {
  NamaDiscoveryRecord(endpoint: try NamaEndpoint(endpoint), serviceName: serviceName)
}

private actor ManualDiscovery: NamaDiscovering {
  private(set) var browseCount = 0
  private(set) var cancellationCount = 0
  private var continuations: [AsyncStream<NamaDiscoveryEvent>.Continuation] = []

  func browse() -> AsyncStream<NamaDiscoveryEvent> {
    browseCount += 1
    let (stream, continuation) = AsyncStream<NamaDiscoveryEvent>.makeStream()
    continuations.append(continuation)
    continuation.onTermination = { [weak self] _ in
      Task {
        await self?.recordCancellation()
      }
    }
    return stream
  }

  func send(_ event: NamaDiscoveryEvent) {
    continuations.last?.yield(event)
  }

  private func recordCancellation() {
    cancellationCount += 1
  }
}

private actor ManualSleeper {
  private(set) var requestedDurations: [Duration] = []
  private var continuations: [AsyncStream<Void>.Continuation] = []

  func sleep(for duration: Duration) async throws {
    requestedDurations.append(duration)
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    continuations.append(continuation)
    for await _ in stream {
      return
    }
    try Task.checkCancellation()
  }

  func releaseFirst() {
    guard let continuation = continuations.first else {
      return
    }
    continuations.removeFirst()
    continuation.yield()
    continuation.finish()
  }
}

private actor RecordingVerifier: ConnectionVerifying {
  private(set) var endpoints: [NamaEndpoint] = []
  private let result: ConnectionVerificationResult

  init(result: ConnectionVerificationResult) {
    self.result = result
  }

  func verify(_ endpoint: NamaEndpoint) -> ConnectionVerificationResult {
    endpoints.append(endpoint)
    return result
  }
}

private actor SuspendingVerifier: ConnectionVerifying {
  private var continuations: [CheckedContinuation<ConnectionVerificationResult, Never>] = []

  var callCount: Int {
    continuations.count
  }

  func verify(_: NamaEndpoint) async -> ConnectionVerificationResult {
    await withCheckedContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resolve(call index: Int, with result: ConnectionVerificationResult) {
    continuations[index].resume(returning: result)
  }
}

private actor CancellationRecordingVerifier: ConnectionVerifying {
  private(set) var endpoints: [NamaEndpoint] = []
  private(set) var cancellationCount = 0

  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult {
    endpoints.append(endpoint)
    let stream = AsyncStream<Void> { continuation in
      continuation.onTermination = { [weak self] _ in
        Task {
          await self?.recordCancellation()
        }
      }
    }
    var iterator = stream.makeAsyncIterator()
    _ = await iterator.next()
    return .cancelled
  }

  private func recordCancellation() {
    cancellationCount += 1
  }
}

private func discoveryCandidates(
  in state: NamaDiscoveryState
) -> [NamaDiscoveryCandidate] {
  guard case .candidates(let candidates) = state else {
    return []
  }
  return candidates
}
