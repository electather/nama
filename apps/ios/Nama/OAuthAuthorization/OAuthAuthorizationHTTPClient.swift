import Foundation

nonisolated final class BetterAuthOAuthAuthorizationClient: OAuthAuthorizationClient, Sendable {
  typealias Send = @Sendable (NamaEndpoint, URLRequest) async throws -> (Data, HTTPURLResponse)

  private static let requestTimeout: TimeInterval = 10
  private static let successfulStatusCodes = 200..<300

  private let send: Send

  init(
    configuration: URLSessionConfiguration = .default,
    send: Send? = nil
  ) {
    self.send =
      send ?? { endpoint, request in
        try await Self.performRequest(
          endpoint: endpoint,
          request: request,
          configuration: configuration
        )
      }
  }

  private static func performRequest(
    endpoint: NamaEndpoint,
    request: URLRequest,
    configuration: URLSessionConfiguration
  ) async throws -> (Data, HTTPURLResponse) {
    let selectedConfiguration: URLSessionConfiguration
    if endpoint.usesUnencryptedHTTP {
      guard let proxyFreeConfiguration = configuration.copy() as? URLSessionConfiguration else {
        preconditionFailure("URLSessionConfiguration did not preserve its type when copied")
      }
      proxyFreeConfiguration.connectionProxyDictionary = [
        "HTTPEnable": false,
        "HTTPSEnable": false,
        "ProxyAutoConfigEnable": false,
        "ProxyAutoDiscoveryEnable": false,
        "SOCKSEnable": false,
      ]
      proxyFreeConfiguration.proxyConfigurations = []
      selectedConfiguration = proxyFreeConfiguration
    } else {
      selectedConfiguration = configuration
    }
    let delegate = OAuthNoRedirectDelegate()
    let session = URLSession(
      configuration: selectedConfiguration,
      delegate: delegate,
      delegateQueue: nil
    )
    defer {
      session.finishTasksAndInvalidate()
    }
    let (data, response) = try await session.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return (data, httpResponse)
  }

  func requestDeviceAuthorization(at endpoint: NamaEndpoint) async throws
    -> OAuthDeviceAuthorization
  {
    let request = try formRequest(
      endpoint: endpoint,
      path: "device/code",
      fields: [
        ("client_id", OAuthConfiguration.applePublicClientID),
        ("scope", OAuthConfiguration.authorizationScopes.joined(separator: " ")),
        ("resource", endpoint.absoluteString),
      ]
    )
    let (data, response) = try await execute(endpoint: endpoint, request: request)
    guard Self.successfulStatusCodes.contains(response.statusCode) else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    let payload: DeviceAuthorizationResponse
    do {
      payload = try Self.decode(DeviceAuthorizationResponse.self, from: data)
    } catch {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    guard
      !payload.deviceCode.isEmpty,
      !payload.userCode.isEmpty,
      payload.expiresIn > 0,
      payload.interval > 0,
      let verificationURI = URL(string: payload.verificationURI),
      verificationURI.scheme == endpoint.url.scheme,
      verificationURI.host == endpoint.url.host,
      verificationURI.port == endpoint.url.port
    else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return OAuthDeviceAuthorization(
      deviceCode: payload.deviceCode,
      userCode: payload.userCode,
      verificationURI: verificationURI,
      expiresIn: TimeInterval(payload.expiresIn),
      interval: TimeInterval(payload.interval)
    )
  }

  func pollToken(
    at endpoint: NamaEndpoint,
    deviceCode: String
  ) async throws -> OAuthTokenPollResult {
    let request = try formRequest(
      endpoint: endpoint,
      path: "oauth2/token",
      fields: [
        ("grant_type", OAuthConfiguration.deviceCodeGrant),
        ("client_id", OAuthConfiguration.applePublicClientID),
        ("device_code", deviceCode),
        ("resource", endpoint.absoluteString),
      ]
    )
    let (data, response) = try await execute(endpoint: endpoint, request: request)
    if Self.successfulStatusCodes.contains(response.statusCode) {
      return .authorized(try tokenBundle(from: data))
    }
    return try pollFailure(from: data)
  }

  func refreshToken(
    at endpoint: NamaEndpoint,
    refreshToken: String
  ) async throws -> OAuthTokenBundle {
    let request = try formRequest(
      endpoint: endpoint,
      path: "oauth2/token",
      fields: [
        ("grant_type", "refresh_token"),
        ("client_id", OAuthConfiguration.applePublicClientID),
        ("refresh_token", refreshToken),
        ("resource", endpoint.absoluteString),
      ]
    )
    let (data, response) = try await execute(endpoint: endpoint, request: request)
    guard Self.successfulStatusCodes.contains(response.statusCode) else {
      let oauthError = try? Self.decode(OAuthErrorResponse.self, from: data)
      if oauthError?.error == "invalid_grant" {
        throw OAuthAuthorizationClientError.invalidGrant
      }
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return try tokenBundle(from: data)
  }

  private func execute(
    endpoint: NamaEndpoint,
    request: URLRequest
  ) async throws -> (Data, HTTPURLResponse) {
    do {
      return try await send(endpoint, request)
    } catch let error as OAuthAuthorizationClientError {
      throw error
    } catch {
      throw OAuthAuthorizationClientError.network
    }
  }

  private func formRequest(
    endpoint: NamaEndpoint,
    path: String,
    fields: [(String, String)]
  ) throws -> URLRequest {
    var components = URLComponents()
    components.queryItems = fields.map { name, value in
      URLQueryItem(name: name, value: value)
    }
    guard let body = components.percentEncodedQuery?.data(using: .utf8) else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    var request = URLRequest(url: endpoint.appending(path: path))
    request.httpMethod = "POST"
    request.httpBody = body
    request.timeoutInterval = Self.requestTimeout
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }

  private func tokenBundle(from data: Data) throws -> OAuthTokenBundle {
    let payload: TokenResponse
    do {
      payload = try Self.decode(TokenResponse.self, from: data)
    } catch {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    let scopes = payload.scope.split(whereSeparator: \.isWhitespace).map(String.init)
    guard
      payload.expiresIn > 0,
      let material = OAuthTokenMaterial(
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        scope: scopes,
        tokenType: payload.tokenType
      )
    else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return OAuthTokenBundle(
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      expiresIn: TimeInterval(payload.expiresIn),
      scope: material.scope,
      tokenType: material.tokenType
    )
  }

  private func pollFailure(from data: Data) throws -> OAuthTokenPollResult {
    let payload: OAuthErrorResponse
    do {
      payload = try Self.decode(OAuthErrorResponse.self, from: data)
    } catch {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    switch payload.error {
    case "authorization_pending":
      return .pending

    case "slow_down":
      return .slowDown

    case "access_denied":
      return .denied

    case "expired_token":
      return .expired

    default:
      throw OAuthAuthorizationClientError.invalidResponse
    }
  }

  private static func decode<Value: Decodable>(
    _ type: Value.Type,
    from data: Data
  ) throws -> Value {
    try JSONDecoder().decode(type, from: data)
  }
}

nonisolated private struct DeviceAuthorizationResponse: Decodable {
  let deviceCode: String
  let userCode: String
  let verificationURI: String
  let expiresIn: Int
  let interval: Int

  private enum CodingKeys: String, CodingKey {
    case deviceCode = "device_code"
    case userCode = "user_code"
    case verificationURI = "verification_uri"
    case expiresIn = "expires_in"
    case interval = "interval"
  }
}

nonisolated private struct TokenResponse: Decodable {
  let accessToken: String
  let refreshToken: String
  let expiresIn: Int
  let scope: String
  let tokenType: String

  private enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case expiresIn = "expires_in"
    case scope = "scope"
    case tokenType = "token_type"
  }
}

nonisolated private struct OAuthErrorResponse: Decodable {
  let error: String
}

nonisolated private final class OAuthNoRedirectDelegate: NSObject, URLSessionTaskDelegate {
  func urlSession(
    _: URLSession,
    task _: URLSessionTask,
    willPerformHTTPRedirection _: HTTPURLResponse,
    newRequest _: URLRequest,
    completionHandler: @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}
