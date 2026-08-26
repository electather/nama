import Foundation
import Synchronization

nonisolated private enum HomeArtworkTransportLimits {
  static let minimumPort = 1
  static let maximumPort = 65_535
  static let maximumURLBytes = 8_192
  static let maximumRedirectOrigins = 16
  static let maximumHeaders = 32
  static let maximumHeaderNameBytes = 256
  static let maximumHeaderValueBytes = 8_192
  static let requestTimeout: TimeInterval = 10
  static let successfulStatusRange = 200..<300
}

nonisolated private struct HomeArtworkOrigin: Hashable, Sendable {
  private static let defaultHTTPPort = 80
  private static let defaultHTTPSPort = 443

  let scheme: String
  let host: String
  let port: Int

  init?(_ destination: URL) {
    guard
      let components = URLComponents(url: destination, resolvingAgainstBaseURL: false),
      components.user == nil,
      components.password == nil,
      let normalizedScheme = components.scheme?.lowercased(),
      normalizedScheme == "http" || normalizedScheme == "https",
      let normalizedHost = components.host?.lowercased(),
      !normalizedHost.isEmpty
    else {
      return nil
    }
    let resolvedPort =
      components.port
      ?? (normalizedScheme == "https" ? Self.defaultHTTPSPort : Self.defaultHTTPPort)
    guard
      (HomeArtworkTransportLimits.minimumPort...HomeArtworkTransportLimits.maximumPort)
        .contains(resolvedPort)
    else {
      return nil
    }
    scheme = normalizedScheme
    host = normalizedHost
    port = resolvedPort
  }

  init?(allowedOrigin: String) {
    guard
      allowedOrigin.utf8.count <= HomeArtworkTransportLimits.maximumURLBytes,
      let allowedURL = URL(string: allowedOrigin),
      let components = URLComponents(url: allowedURL, resolvingAgainstBaseURL: false),
      components.path.isEmpty,
      components.query == nil,
      components.fragment == nil
    else {
      return nil
    }
    self.init(allowedURL)
  }
}

nonisolated struct HomeArtworkRedirectPolicy: Sendable {
  private let initialOrigin: HomeArtworkOrigin
  private let headers: [HomeArtworkHeader]
  private let allowedOrigins: Set<HomeArtworkOrigin>

  init?(
    initialURL: URL,
    headers: [HomeArtworkHeader],
    allowedRedirectOrigins: [String]
  ) {
    guard
      let resolvedInitialOrigin = HomeArtworkOrigin(initialURL),
      (1...HomeArtworkTransportLimits.maximumRedirectOrigins)
        .contains(allowedRedirectOrigins.count)
    else {
      return nil
    }
    let parsedOrigins = allowedRedirectOrigins.compactMap(
      HomeArtworkOrigin.init(allowedOrigin:)
    )
    let originSet = Set(parsedOrigins)
    guard
      parsedOrigins.count == allowedRedirectOrigins.count,
      originSet.contains(resolvedInitialOrigin)
    else {
      return nil
    }
    initialOrigin = resolvedInitialOrigin
    self.headers = headers
    allowedOrigins = originSet
  }

  func redirectedRequest(
    _ request: URLRequest,
    hasLeftInitialOrigin: inout Bool
  ) -> URLRequest? {
    guard
      let destination = request.url,
      let destinationOrigin = HomeArtworkOrigin(destination),
      allowedOrigins.contains(destinationOrigin)
    else {
      return nil
    }
    if destinationOrigin != initialOrigin {
      hasLeftInitialOrigin = true
    }
    var redirectedRequest = request
    for header in headers {
      redirectedRequest.setValue(nil, forHTTPHeaderField: header.name)
    }
    redirectedRequest.setValue(nil, forHTTPHeaderField: "Cookie")
    redirectedRequest.setValue(nil, forHTTPHeaderField: "Proxy-Authorization")
    if !hasLeftInitialOrigin {
      for header in headers {
        redirectedRequest.setValue(header.value, forHTTPHeaderField: header.name)
      }
    }
    return redirectedRequest
  }
}

nonisolated struct ValidatedArtworkLocator: Sendable {
  let url: URL
  let headers: [HomeArtworkHeader]
  let redirectPolicy: HomeArtworkRedirectPolicy
  let refreshAt: Date
  let accessExpiresAt: Date?

  init?(_ locator: HomeArtworkResolvedLocator, now: Date) {
    let accessExpiryIsValid =
      locator.accessExpiresAt.map { expiry in
        expiry > now && locator.refreshAt <= expiry
      } ?? true
    let widthIsValid = locator.width.map { width in width > .zero } ?? true
    let heightIsValid = locator.height.map { height in height > .zero } ?? true
    guard
      locator.url.utf8.count <= HomeArtworkTransportLimits.maximumURLBytes,
      let resolvedURL = URL(string: locator.url),
      let resolvedURLComponents = URLComponents(
        url: resolvedURL,
        resolvingAgainstBaseURL: false
      )
    else {
      return nil
    }
    let authorizationIsBounded =
      locator.accessExpiresAt != nil
      || (locator.headers.isEmpty && resolvedURLComponents.query == nil)
    guard
      authorizationIsBounded,
      let resolvedRedirectPolicy = HomeArtworkRedirectPolicy(
        initialURL: resolvedURL,
        headers: locator.headers,
        allowedRedirectOrigins: locator.allowedRedirectOrigins
      ),
      Self.headersAreValid(locator.headers),
      locator.refreshAt > now,
      accessExpiryIsValid,
      widthIsValid,
      heightIsValid
    else {
      return nil
    }
    url = resolvedURL
    headers = locator.headers
    redirectPolicy = resolvedRedirectPolicy
    refreshAt = locator.refreshAt
    accessExpiresAt = locator.accessExpiresAt
  }

  func canStartFetch(at date: Date) -> Bool {
    date < refreshAt && accessExpiresAt.map { expiry in date < expiry } ?? true
  }

  private static func headersAreValid(_ headers: [HomeArtworkHeader]) -> Bool {
    guard headers.count <= HomeArtworkTransportLimits.maximumHeaders else {
      return false
    }
    var normalizedHeaderNames: Set<String> = []
    for header in headers {
      let normalizedName = header.name.lowercased()
      guard
        (1...HomeArtworkTransportLimits.maximumHeaderNameBytes)
          .contains(header.name.utf8.count),
        (1...HomeArtworkTransportLimits.maximumHeaderValueBytes)
          .contains(header.value.utf8.count),
        Self.isHTTPToken(header.name),
        !header.value.contains("\r"),
        !header.value.contains("\n"),
        normalizedHeaderNames.insert(normalizedName).inserted
      else {
        return false
      }
    }
    return true
  }

  private static func isHTTPToken(_ value: String) -> Bool {
    let allowedPunctuation = CharacterSet(charactersIn: "!#$%&'*+-.^_`|~")
    let allowedCharacters = CharacterSet.alphanumerics.union(allowedPunctuation)
    return !value.isEmpty
      && value.unicodeScalars.allSatisfy { scalar in
        scalar.isASCII && allowedCharacters.contains(scalar)
      }
  }
}

nonisolated struct HomeArtworkHTTPClient: Sendable {
  let configuration: URLSessionConfiguration
  let maximumEncodedBytes: Int

  func fetch(_ locator: ValidatedArtworkLocator) async throws -> Data {
    guard let isolatedConfiguration = configuration.copy() as? URLSessionConfiguration else {
      throw URLError(.cannotCreateFile)
    }
    isolatedConfiguration.urlCache = nil
    isolatedConfiguration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    isolatedConfiguration.httpCookieStorage = nil
    isolatedConfiguration.httpShouldSetCookies = false
    isolatedConfiguration.urlCredentialStorage = nil
    isolatedConfiguration.httpAdditionalHeaders = nil
    let delegate = HomeArtworkRedirectDelegate(locator: locator)
    let session = URLSession(configuration: isolatedConfiguration)
    defer { session.invalidateAndCancel() }

    var request = URLRequest(
      url: locator.url,
      cachePolicy: .reloadIgnoringLocalAndRemoteCacheData,
      timeoutInterval: HomeArtworkTransportLimits.requestTimeout
    )
    for header in locator.headers {
      request.setValue(header.value, forHTTPHeaderField: header.name)
    }
    let (bytes, rawResponse) = try await session.bytes(for: request, delegate: delegate)
    guard
      !Task.isCancelled,
      let response = rawResponse as? HTTPURLResponse,
      HomeArtworkTransportLimits.successfulStatusRange.contains(response.statusCode),
      response.expectedContentLength <= Int64(maximumEncodedBytes),
      response.mimeType?.lowercased().hasPrefix("image/") == true
    else {
      throw URLError(.cannotDecodeContentData)
    }
    var data = Data()
    if response.expectedContentLength > .zero {
      data.reserveCapacity(Int(response.expectedContentLength))
    }
    for try await byte in bytes {
      guard data.count < maximumEncodedBytes else {
        throw URLError(.dataLengthExceedsMaximum)
      }
      data.append(byte)
    }
    guard !Task.isCancelled else {
      throw CancellationError()
    }
    return data
  }
}

nonisolated private final class HomeArtworkRedirectDelegate: NSObject, URLSessionTaskDelegate {
  private let policy: HomeArtworkRedirectPolicy
  private let hasLeftInitialOrigin = Mutex(false)

  init(locator: ValidatedArtworkLocator) {
    policy = locator.redirectPolicy
  }

  func urlSession(
    _: URLSession,
    task _: URLSessionTask,
    willPerformHTTPRedirection _: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @Sendable (URLRequest?) -> Void
  ) {
    let redirectedRequest = hasLeftInitialOrigin.withLock { hasLeftInitialOrigin in
      policy.redirectedRequest(
        request,
        hasLeftInitialOrigin: &hasLeftInitialOrigin
      )
    }
    completionHandler(redirectedRequest)
  }
}
