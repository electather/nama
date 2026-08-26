import Foundation
import Testing

@testable import Nama

nonisolated private enum OAuthTransportFixture {
  static let deviceAuthorizationCallCount = 1
  static let initialTokenCallCount = 2
  static let refreshedTokenCallCount = 3
  static let initialTokenExpiresIn: TimeInterval = 100
  static let successfulHTTPStatus = 200
  static let unavailableHTTPStatus = 500
  static let unimplementedHTTPStatus = 501
  static let tokenExpiry: TimeInterval = 4_600
}

@Suite("OAuth authorization transports", .serialized)
@MainActor
struct OAuthAuthorizationTransportTests {
  @Test("the concrete scoped verifier accepts CATALOG_NOT_READY as authenticated access")
  func concreteScopedVerifierUsesBearer() async throws {
    OAuthConnectStubURLProtocol.configure(
      status: OAuthTransportFixture.unavailableHTTPStatus,
      body: #"""
        {
          "code": "unavailable",
          "message": "catalog is not ready",
          "details": [
            {
              "type": "google.rpc.ErrorInfo",
              "value": "ChFDQVRBTE9HX05PVF9SRUFEWRILbmFtYS5hcGkudjE="
            },
            {
              "type": "google.rpc.RetryInfo",
              "value": "CgIICQ=="
            }
          ]
        }
        """#
    )
    defer { OAuthConnectStubURLProtocol.reset() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OAuthConnectStubURLProtocol.self]
    let record = try oauthTransportTokenRecord()
    let verifier = NamaLibraryClient(
      clientVersion: "1.0.0",
      tokenStore: InMemoryOAuthTokenStore(snapshot: .record(record)),
      sessionConfiguration: configuration,
      platform: "tvos"
    )

    try await verifier.verify(record)

    let request = try #require(OAuthConnectStubURLProtocol.recordedRequests.first)
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token-secret")
    #expect(request.value(forHTTPHeaderField: "nama-client-platform") == "tvos")
    #expect(request.url?.path == "/nama.api.v1.LibraryService/GetHome")
  }

  @Test("a foreign CATALOG_NOT_READY detail is not authenticated access")
  func foreignCatalogReasonIsRejected() async throws {
    OAuthConnectStubURLProtocol.configure(
      status: OAuthTransportFixture.unavailableHTTPStatus,
      body: #"""
        {
          "code": "unavailable",
          "message": "catalog is not ready",
          "details": [
            {
              "type": "google.rpc.ErrorInfo",
              "value": "ChFDQVRBTE9HX05PVF9SRUFEWRILZm9yZWlnbi5hcGk="
            }
          ]
        }
        """#
    )
    defer { OAuthConnectStubURLProtocol.reset() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OAuthConnectStubURLProtocol.self]
    let record = try oauthTransportTokenRecord()
    let verifier = NamaLibraryClient(
      clientVersion: "1.0.0",
      tokenStore: InMemoryOAuthTokenStore(snapshot: .record(record)),
      sessionConfiguration: configuration,
      platform: "ios"
    )

    await #expect(throws: OAuthAuthorizationClientError.network) {
      try await verifier.verify(record)
    }
  }

  @Test("an unimplemented LibraryService is incompatible consumer access")
  func unimplementedLibraryIsIncompatible() async throws {
    OAuthConnectStubURLProtocol.configure(
      status: OAuthTransportFixture.unimplementedHTTPStatus,
      body: #"{"code":"unimplemented","message":"LibraryService.GetHome is not implemented"}"#
    )
    defer { OAuthConnectStubURLProtocol.reset() }
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OAuthConnectStubURLProtocol.self]
    let record = try oauthTransportTokenRecord()
    let verifier = NamaLibraryClient(
      clientVersion: "1.0.0",
      tokenStore: InMemoryOAuthTokenStore(snapshot: .record(record)),
      sessionConfiguration: configuration,
      platform: "ios"
    )

    await #expect(throws: OAuthAuthorizationClientError.invalidResponse) {
      try await verifier.verify(record)
    }
  }

  @Test("the concrete native HTTP client runs device, token, and refresh exchanges")
  func concreteNativeOAuthHTTPFlow() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let script = ScriptedOAuthHTTPFlow(endpoint: endpoint)
    let client = BetterAuthOAuthAuthorizationClient(send: script.callAsFunction)

    let authorization = try await client.requestDeviceAuthorization(at: endpoint)
    let poll = try await client.pollToken(
      at: endpoint,
      deviceCode: authorization.deviceCode
    )
    let refreshed = try await client.refreshToken(
      at: endpoint,
      refreshToken: "initial-refresh-token"
    )

    #expect(authorization.userCode == "ABCD-EFGH")
    #expect(
      poll
        == .authorized(
          OAuthTokenBundle(
            accessToken: "initial-access-token",
            refreshToken: "initial-refresh-token",
            expiresIn: OAuthTransportFixture.initialTokenExpiresIn,
            scope: OAuthConfiguration.consumerScopes,
            tokenType: "Bearer"
          )
        )
    )
    #expect(refreshed.accessToken == "refreshed-access-token")
    #expect(refreshed.refreshToken == "rotated-refresh-token")
    #expect(
      await script.paths == ["/device/code", "/oauth2/token", "/oauth2/token"]
    )
    let bodies = await script.bodies
    #expect(bodies.count == OAuthTransportFixture.refreshedTokenCallCount)
    #expect(bodies.contains { $0.contains("client_id=nama-apple") })
    #expect(bodies.contains { $0.contains("device_code=device-code-secret") })
    #expect(bodies.contains { $0.contains("grant_type=refresh_token") })
    #expect(bodies.contains { $0.contains("refresh_token=initial-refresh-token") })
  }
}

private func oauthTransportTokenRecord() throws -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    accessTokenExpiresAt: Date(timeIntervalSince1970: OAuthTransportFixture.tokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}

private actor ScriptedOAuthHTTPFlow {
  private let verificationURI: String
  private(set) var paths: [String] = []
  private(set) var bodies: [String] = []

  init(endpoint: NamaEndpoint) {
    verificationURI = endpoint.appending(path: "device").absoluteString
  }

  func callAsFunction(
    _ endpoint: NamaEndpoint,
    _ request: URLRequest
  ) async throws -> (Data, HTTPURLResponse) {
    await Task.yield()
    guard
      let url = request.url,
      url.scheme == endpoint.url.scheme,
      url.host == endpoint.url.host,
      url.port == endpoint.url.port
    else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    paths.append(url.path)
    bodies.append(request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    let body: String
    switch paths.count {
    case OAuthTransportFixture.deviceAuthorizationCallCount:
      body =
        #"{"device_code":"device-code-secret","user_code":"ABCD-EFGH","#
        + #""verification_uri":"\#(verificationURI)","expires_in":600,"interval":5}"#

    case OAuthTransportFixture.initialTokenCallCount:
      body =
        #"{"access_token":"initial-access-token","refresh_token":"initial-refresh-token","#
        + #""expires_in":100,"scope":"nama:library nama:playback nama:user-state","token_type":"Bearer"}"#

    case OAuthTransportFixture.refreshedTokenCallCount:
      body =
        #"{"access_token":"refreshed-access-token","refresh_token":"rotated-refresh-token","#
        + #""expires_in":3600,"scope":"nama:library nama:playback nama:user-state","token_type":"Bearer"}"#

    default:
      throw OAuthAuthorizationClientError.invalidResponse
    }
    guard
      let response = HTTPURLResponse(
        url: url,
        statusCode: OAuthTransportFixture.successfulHTTPStatus,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )
    else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return (Data(body.utf8), response)
  }
}

nonisolated private class OAuthConnectStubURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var responseStatus = OAuthTransportFixture
    .unavailableHTTPStatus
  nonisolated(unsafe) private static var responseBody = ""
  nonisolated(unsafe) private static var requests: [URLRequest] = []

  static var recordedRequests: [URLRequest] {
    lock.withLock { requests }
  }

  static func configure(status: Int, body: String) {
    lock.withLock {
      responseStatus = status
      responseBody = body
      requests = []
    }
  }

  static func reset() {
    configure(status: OAuthTransportFixture.unavailableHTTPStatus, body: "")
  }

  override class func canInit(with _: URLRequest) -> Bool {
    true
  }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    let response = Self.lock.withLock { () -> (Int, String) in
      Self.requests.append(request)
      return (Self.responseStatus, Self.responseBody)
    }
    guard
      let url = request.url,
      let httpResponse = HTTPURLResponse(
        url: url,
        statusCode: response.0,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(response.1.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {
    // URLProtocol has no active work to stop in this synchronous fixture.
  }
}
