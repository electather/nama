import Foundation
import Testing

@testable import Nama

@Suite("Connection verification state")
struct ConnectionFeatureTests {
  @Test("invalid input is preserved and reported only after submission")
  func invalidInput() async {
    let verifier = ImmediateVerifier(result: .ready)
    let feature = ConnectionFeature(verifier: verifier)
    feature.address = "nama.example.com"

    #expect(feature.state == .editing(showsValidationError: false))
    feature.submit()

    #expect(feature.address == "nama.example.com")
    #expect(feature.state == .editing(showsValidationError: true))
    #expect(await verifier.callCount == 0)
  }

  @Test(
    "a completed status becomes an honest terminal state",
    arguments: [true, false]
  )
  func terminalState(initialized: Bool) async throws {
    let result: ConnectionVerificationResult = initialized ? .ready : .setupRequired
    let verifier = ImmediateVerifier(result: result)
    let feature = ConnectionFeature(verifier: verifier)
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let expected: ConnectionState = initialized ? .ready(endpoint) : .setupRequired(endpoint)
    feature.address = endpoint.absoluteString

    feature.submit()
    await eventually { feature.state == expected }

    #expect(await verifier.callCount == 1)
  }

  @Test("editing the address cancels an active request")
  func editingCancelsRequest() async throws {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(verifier: verifier)
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.address = "https://other.example.com"
    feature.addressDidChange()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
  }

  @Test("submitting another endpoint replaces the active request")
  func submittingAgainCancelsRequest() async throws {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(verifier: verifier)
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
    let feature = ConnectionFeature(verifier: verifier)
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

  @Test("Retry starts one fresh attempt without an automatic loop")
  func retryIsExplicit() async {
    let verifier = ImmediateVerifier(result: .failure(.namaUnavailable))
    let feature = ConnectionFeature(verifier: verifier)
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }
    await Task.yield()

    #expect(await verifier.callCount == 1)
    feature.retry()
    await eventually { await verifier.callCount == 2 }
    await Task.yield()

    #expect(await verifier.callCount == 2)
  }

  @Test("Cancel ends the active attempt without presenting a failure")
  func explicitCancel() async {
    let verifier = CancellationVerifier()
    let feature = ConnectionFeature(verifier: verifier)
    feature.address = "https://nama.example.com"
    feature.submit()
    await eventually { await verifier.callCount == 1 }

    feature.cancel()
    await eventually { await verifier.cancellationCount == 1 }

    #expect(feature.state == .editing(showsValidationError: false))
  }
}

private actor ImmediateVerifier: ConnectionVerifying {
  private(set) var callCount = 0
  private let result: ConnectionVerificationResult

  init(result: ConnectionVerificationResult) {
    self.result = result
  }

  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult {
    callCount += 1
    return result
  }
}

private actor CancellationVerifier: ConnectionVerifying {
  private(set) var callCount = 0
  private(set) var cancellationCount = 0

  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult {
    callCount += 1
    do {
      try await Task.sleep(for: .seconds(60))
      return .ready
    } catch {
      cancellationCount += 1
      return .cancelled
    }
  }
}

private actor ManualVerifier: ConnectionVerifying {
  private var continuations: [CheckedContinuation<ConnectionVerificationResult, Never>] = []

  var callCount: Int {
    continuations.count
  }

  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult {
    await withCheckedContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resolve(call index: Int, with result: ConnectionVerificationResult) {
    continuations[index].resume(returning: result)
  }
}
