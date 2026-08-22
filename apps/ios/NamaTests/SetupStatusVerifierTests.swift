import Foundation
import Testing

@testable import Nama

@Suite("Setup status networking edge", .serialized)
struct SetupStatusVerifierTests {
  @Test("calls the generated setup RPC once with the canonical prefix and client metadata")
  func readyRequest() async throws {
    StubURLProtocol.configure(.response(status: 200, body: #"{"initialized":true}"#))
    let verifier = makeVerifier()
    let endpoint = try NamaEndpoint("https://nama.example.com/reverse-proxy")

    let result = await verifier.verify(endpoint)
    let requests = StubURLProtocol.recordedRequests

    #expect(result == .ready)
    #expect(requests.count == 1)
    #expect(requests[0].httpMethod == "POST")
    #expect(requests[0].url?.path == "/reverse-proxy/nama.api.v1.SetupService/GetStatus")
    #expect(requests[0].value(forHTTPHeaderField: "nama-client-name") == "nama-ios")
    #expect(requests[0].value(forHTTPHeaderField: "nama-client-platform") == "macos")
    #expect(requests[0].value(forHTTPHeaderField: "nama-client-version") == "1.2.3")
  }

  @Test("maps an uninitialized Nama response to setup required")
  func setupRequired() async throws {
    StubURLProtocol.configure(.response(status: 200, body: #"{"initialized":false}"#))

    let result = await makeVerifier().verify(try NamaEndpoint("https://nama.example.com"))

    #expect(result == .setupRequired)
    #expect(StubURLProtocol.recordedRequests.count == 1)
  }

  @Test(
    "maps safe server response failures",
    arguments: [
      (
        503, #"{"code":"unavailable","message":"private detail"}"#,
        ConnectionVerificationResult.failure(.namaUnavailable)
      ),
      (404, "not found", ConnectionVerificationResult.failure(.incompatible)),
      (200, "<html>not Nama</html>", ConnectionVerificationResult.failure(.incompatible)),
    ]
  )
  func responseFailure(status: Int, body: String, expected: ConnectionVerificationResult)
    async throws
  {
    StubURLProtocol.configure(.response(status: status, body: body))

    let result = await makeVerifier().verify(try NamaEndpoint("https://nama.example.com"))

    #expect(result == expected)
  }

  @Test("maps a remote cancellation to a visible connection failure")
  func remoteCancellation() async throws {
    StubURLProtocol.configure(
      .response(status: 499, body: #"{"code":"canceled","message":"private detail"}"#)
    )

    let result = await makeVerifier().verify(try NamaEndpoint("https://nama.example.com"))

    #expect(result == .failure(.cannotConnect))
  }

  @Test(
    "maps transport, TLS, and timeout failures without exposing details",
    arguments: [
      URLError.Code.cannotConnectToHost,
      URLError.Code.secureConnectionFailed,
      URLError.Code.timedOut,
    ]
  )
  func transportFailure(code: URLError.Code) async throws {
    StubURLProtocol.configure(.failure(code))

    let result = await makeVerifier().verify(try NamaEndpoint("https://nama.example.com"))

    #expect(result == .failure(.cannotConnect))
  }

  @Test("task cancellation cancels the active URL request")
  func cancellation() async throws {
    StubURLProtocol.configure(.hold)
    let verifier = makeVerifier()
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let task = Task { await verifier.verify(endpoint) }
    await eventually { StubURLProtocol.recordedRequests.count == 1 }

    task.cancel()
    let result = await task.value
    await eventually { StubURLProtocol.stopCount == 1 }

    #expect(result == .cancelled)
  }

  private func makeVerifier() -> NamaSetupStatusVerifier {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return NamaSetupStatusVerifier(
      sessionConfiguration: configuration,
      clientVersion: "1.2.3",
      platform: "macos"
    )
  }
}

private nonisolated final class StubURLProtocol: URLProtocol, @unchecked Sendable {
  enum Outcome: Sendable {
    case response(status: Int, body: String)
    case failure(URLError.Code)
    case hold
  }

  private static let lock = NSLock()
  private nonisolated(unsafe) static var outcome: Outcome = .hold
  private nonisolated(unsafe) static var requests: [URLRequest] = []
  private nonisolated(unsafe) static var stopped = 0

  static var recordedRequests: [URLRequest] {
    lock.withLock { requests }
  }

  static var stopCount: Int {
    lock.withLock { stopped }
  }

  static func configure(_ newOutcome: Outcome) {
    lock.withLock {
      outcome = newOutcome
      requests = []
      stopped = 0
    }
  }

  override class func canInit(with request: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    let current = Self.lock.withLock { () -> Outcome in
      Self.requests.append(request)
      return Self.outcome
    }
    switch current {
    case .response(let status, let body):
      guard
        let url = request.url,
        let response = HTTPURLResponse(
          url: url,
          statusCode: status,
          httpVersion: "HTTP/1.1",
          headerFields: ["content-type": "application/json"]
        )
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.badURL))
        return
      }
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)
    case .failure(let code):
      client?.urlProtocol(self, didFailWithError: URLError(code))
    case .hold:
      break
    }
  }

  override func stopLoading() {
    Self.lock.withLock {
      Self.stopped += 1
    }
  }
}
