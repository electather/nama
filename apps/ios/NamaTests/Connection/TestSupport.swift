import Testing

@testable import Nama

func eventually(
  _ condition: @MainActor @Sendable () async -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  let maximumTaskYields = 1_000
  for _ in 0..<maximumTaskYields {
    if await condition() {
      return
    }
    await Task.yield()
  }
  Issue.record("Condition did not become true", sourceLocation: sourceLocation)
}

actor CancellationVerifier: ConnectionVerifying {
  private(set) var callCount = 0
  private(set) var cancellationCount = 0

  private static let cancellationDelaySeconds = 60
  private static let cancellationDelay = Duration.seconds(cancellationDelaySeconds)

  func verify(_: NamaEndpoint) async -> ConnectionVerificationResult {
    callCount += 1
    do {
      try await Task.sleep(for: Self.cancellationDelay)
      return .ready
    } catch {
      cancellationCount += 1
      return .cancelled
    }
  }
}

actor ManualVerifier: ConnectionVerifying {
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

actor InMemoryVerifiedEndpointStore: VerifiedEndpointStoring {
  private(set) var endpoint: NamaEndpoint?
  private var generation: UInt64 = 0

  init(endpoint: NamaEndpoint? = nil) {
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

  func clear() {
    generation &+= 1
    endpoint = nil
  }
}
