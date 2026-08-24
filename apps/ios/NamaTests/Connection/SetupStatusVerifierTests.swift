import Connect
import Foundation
import Network
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

  @Test("uses a proxy-free endpoint-scoped session for permitted local HTTP")
  func localHTTPProxySelection() throws {
    let selectedConfiguration = try selectedSessionConfiguration(
      for: NamaEndpoint("http://nama.local"),
      suppliedConfiguration: makeProxiedConfiguration()
    )
    let proxySettings = try #require(selectedConfiguration.connectionProxyDictionary)
    #expect(proxySettings["HTTPEnable"] as? Bool == false)
    #expect(proxySettings["SOCKSEnable"] as? Bool == false)
    #expect(proxySettings["ProxyAutoConfigEnable"] as? Bool == false)
    #expect(proxySettings["ProxyAutoDiscoveryEnable"] as? Bool == false)
    #expect(selectedConfiguration.proxyConfigurations.isEmpty)
  }

  @Test("preserves the supplied proxy configuration for HTTPS")
  func httpsProxySelection() throws {
    let suppliedConfiguration = makeProxiedConfiguration()
    _ = try selectedSessionConfiguration(
      for: NamaEndpoint("http://nama.local"),
      suppliedConfiguration: suppliedConfiguration
    )
    let selectedConfiguration = try selectedSessionConfiguration(
      for: NamaEndpoint("https://nama.example.com"),
      suppliedConfiguration: suppliedConfiguration
    )
    let proxySettings = try #require(selectedConfiguration.connectionProxyDictionary)
    #expect(proxySettings["HTTPEnable"] as? Bool == true)
    #expect(proxySettings["HTTPProxy"] as? String == "configured-proxy.invalid")
    #expect(proxySettings["ProxyAutoConfigEnable"] as? Bool == true)
    #expect(selectedConfiguration.proxyConfigurations.count == 1)
  }

  @Test(
    "refuses redirects before target contact and maps them to incompatible",
    arguments: [
      ("http://nama.local", "nama.local"),
      ("https://nama.example.com", "nama.example.com"),
    ]
  )
  func redirect(endpointValue: String, expectedHost: String) async throws {
    let redirectTarget = try #require(URL(string: "https://redirect.example/private-target"))
    StubURLProtocol.configure(
      .redirect(
        redirectTarget,
        body: #"{"code":"unavailable","message":"redirect-controlled"}"#
      )
    )
    defer { StubURLProtocol.reset() }

    let result = await makeVerifier().verify(try NamaEndpoint(endpointValue))
    let requests = StubURLProtocol.recordedRequests

    #expect(result == .failure(.incompatible))
    #expect(requests.count == 1)
    #expect(requests.first?.url?.host == expectedHost)
  }

  @Test("keeps redirect location metadata and body inside URLSession")
  func redirectMetadata() async throws {
    let redirectTarget = try #require(URL(string: "https://redirect.example/private-target"))
    StubURLProtocol.configure(.redirect(redirectTarget, body: "redirect-controlled"))
    defer { StubURLProtocol.reset() }
    let transport = NamaUnaryURLSessionHTTPClient(
      endpoint: try NamaEndpoint("https://nama.example.com"),
      configuration: makeConfiguration()
    )
    let request = HTTPRequest<Data?>(
      url: try #require(URL(string: "https://nama.example.com/status")),
      headers: [:],
      message: Data(),
      method: .post,
      trailers: nil,
      idempotencyLevel: .noSideEffects
    )

    let response = await withCheckedContinuation { continuation in
      transport.unary(
        request: request,
        onMetrics: { _ in
          // Metrics are not part of this transport assertion.
        },
        onResponse: { continuation.resume(returning: $0) }
      )
    }

    #expect(response.headers["location"] == nil)
    #expect(response.message == nil)
  }

  @Test("rejects accidental streaming without starting a request")
  func streaming() throws {
    StubURLProtocol.configure(.hold)
    defer { StubURLProtocol.reset() }
    let transport = NamaUnaryURLSessionHTTPClient(
      endpoint: try NamaEndpoint("https://nama.example.com"),
      configuration: makeConfiguration()
    )
    let request = HTTPRequest<Data?>(
      url: try #require(URL(string: "https://nama.example.com/stream")),
      headers: [:],
      message: nil,
      method: .post,
      trailers: nil,
      idempotencyLevel: .unknown
    )
    let recorder = StreamCloseRecorder()
    let requestCallbacks = transport.stream(
      request: request,
      responseCallbacks: ResponseCallbacks(
        receiveResponseHeaders: { _ in
          // Streaming response callbacks must remain unused.
        },
        receiveResponseData: { _ in
          // Streaming response callbacks must remain unused.
        },
        receiveResponseMetrics: { _ in
          // Streaming response callbacks must remain unused.
        },
        receiveClose: { recorder.record(code: $0, error: $2) }
      )
    )
    let result = recorder.result
    requestCallbacks.cancel()

    #expect(result.code == .unimplemented)
    #expect(result.errorCode == .unimplemented)
    #expect(StubURLProtocol.recordedRequests.isEmpty)
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

  @Test(
    "task cancellation cancels the active URL request",
    arguments: ["http://nama.local", "https://nama.example.com"]
  )
  func cancellation(endpointValue: String) async throws {
    StubURLProtocol.configure(.hold)
    let verifier = makeVerifier()
    let endpoint = try NamaEndpoint(endpointValue)
    let task = Task { await verifier.verify(endpoint) }
    await eventually { StubURLProtocol.recordedRequests.count == 1 }

    task.cancel()
    let result = await task.value
    await eventually { StubURLProtocol.stopCount == 1 }

    #expect(result == .cancelled)
  }

  private func makeVerifier() -> NamaSetupStatusVerifier {
    NamaSetupStatusVerifier(
      clientVersion: "1.2.3",
      sessionConfiguration: makeConfiguration(),
      platform: "macos"
    )
  }

  private func makeConfiguration() -> URLSessionConfiguration {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return configuration
  }

  private func selectedSessionConfiguration(
    for endpoint: NamaEndpoint,
    suppliedConfiguration: URLSessionConfiguration
  ) throws -> URLSessionConfiguration {
    var selectedConfiguration: URLSessionConfiguration?
    let transport = NamaUnaryURLSessionHTTPClient(
      endpoint: endpoint,
      configuration: suppliedConfiguration
    ) { configuration in
      selectedConfiguration = configuration
      return URLSession(configuration: configuration)
    }
    defer { _ = transport }
    return try #require(selectedConfiguration)
  }

  private func makeProxiedConfiguration() -> URLSessionConfiguration {
    let configuration = makeConfiguration()
    configuration.connectionProxyDictionary = [
      "HTTPEnable": true,
      "HTTPProxy": "configured-proxy.invalid",
      "ProxyAutoConfigEnable": true,
      "ProxyAutoDiscoveryEnable": true,
      "SOCKSEnable": true,
    ]
    configuration.proxyConfigurations = [
      ProxyConfiguration(
        httpCONNECTProxy: .hostPort(host: "configured-proxy.invalid", port: 8_080)
      ),
    ]
    return configuration
  }
}

nonisolated private final class StreamCloseRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var code: Code?
  private var errorCode: Code?

  var result: (code: Code?, errorCode: Code?) {
    lock.withLock { (code, errorCode) }
  }

  func record(code: Code, error: (any Error)?) {
    lock.withLock {
      self.code = code
      errorCode = (error as? ConnectError)?.code
    }
  }
}

nonisolated private final class StubURLProtocol: URLProtocol, @unchecked Sendable {
  enum Outcome: Sendable {
    case response(status: Int, body: String)
    case redirect(URL, body: String)
    case failure(URLError.Code)
    case hold
  }

  private static let lock = NSLock()
  private static let redirectStatus = 302
  nonisolated(unsafe) private static var outcome: Outcome = .hold
  nonisolated(unsafe) private static var requests: [URLRequest] = []
  nonisolated(unsafe) private static var stopped = 0

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

  static func reset() {
    configure(.hold)
  }

  // URLProtocol requires these overrides to remain class methods.
  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
  override class func canInit(with _: URLRequest) -> Bool {
    true
  }

  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
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

    case .redirect(let target, let body):
      guard
        let url = request.url,
        let response = HTTPURLResponse(
          url: url,
          statusCode: Self.redirectStatus,
          httpVersion: "HTTP/1.1",
          headerFields: ["location": target.absoluteString]
        )
      else {
        client?.urlProtocol(self, didFailWithError: URLError(.badURL))
        return
      }
      client?.urlProtocol(
        self,
        wasRedirectedTo: URLRequest(url: target),
        redirectResponse: response
      )
      client?.urlProtocol(self, didLoad: Data(body.utf8))
      client?.urlProtocolDidFinishLoading(self)

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
