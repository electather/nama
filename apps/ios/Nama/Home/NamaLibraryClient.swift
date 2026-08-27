import Connect
import Foundation
import NamaAPI

nonisolated struct NamaLibraryClient: OAuthScopedAccessVerifying, HomeLoading {
  private let clientVersion: String
  private let platform: String
  private let sessionConfiguration: URLSessionConfiguration
  let tokenStore: any OAuthTokenStoring

  static let apiErrorDomain = "nama.api.v1"
  private static let requestTimeout: TimeInterval = 10
  private static let canonicalRequestIDLength = 36
  private static let nanosecondsPerSecond: Int32 = 1_000_000_000

  init(
    clientVersion: String,
    tokenStore: any OAuthTokenStoring,
    sessionConfiguration: URLSessionConfiguration = .default,
    platform: String = Self.currentPlatform
  ) {
    self.clientVersion = clientVersion
    self.tokenStore = tokenStore
    self.sessionConfiguration = sessionConfiguration
    self.platform = platform
  }

  func verify(_ record: EndpointBoundOAuthTokenRecord) async throws {
    let result = await getHome(using: record)
    if Task.isCancelled {
      throw CancellationError()
    }

    switch result {
    case .success:
      return

    case .failure(let error) where Self.isCatalogNotReady(error):
      return

    case .failure(let error):
      throw Self.mapAuthorizationFailure(error)
    }
  }

  func load(for authorization: HomeAuthorizationIdentity) async throws -> HomeSnapshot {
    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw HomeLoadingFailure.authorizationUnavailable
    }

    let result = await getHome(using: record)
    if Task.isCancelled {
      throw CancellationError()
    }
    switch result {
    case .success(let response):
      do {
        return try Self.mapHomeResponse(response)
      } catch {
        throw HomeLoadingFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapHomeFailure(error)
    }
  }

  private func getHome(
    using record: EndpointBoundOAuthTokenRecord
  ) async -> Result<Nama_Api_V1_GetHomeResponse, ConnectError> {
    let response = await libraryClient(using: record).getHome(
      request: Nama_Api_V1_GetHomeRequest()
    )
    return response.result
  }

  func libraryClient(
    using record: EndpointBoundOAuthTokenRecord
  ) -> Nama_Api_V1_LibraryServiceClient {
    let transport = NamaUnaryURLSessionHTTPClient(
      endpoint: record.endpoint,
      configuration: sessionConfiguration
    )
    let metadataInterceptor = InterceptorFactory { _ in
      NamaConsumerMetadataInterceptor(
        accessToken: record.accessToken,
        clientVersion: clientVersion,
        platform: platform
      )
    }
    let protocolClient = ProtocolClient(
      httpClient: transport,
      config: ProtocolClientConfig(
        host: record.endpoint.absoluteString,
        networkProtocol: .connect,
        timeout: Self.requestTimeout,
        interceptors: [metadataInterceptor]
      )
    )
    return Nama_Api_V1_LibraryServiceClient(client: protocolClient)
  }

  private static func isCatalogNotReady(_ error: ConnectError) -> Bool {
    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    return error.code == .unavailable
      && errorInfo.contains { detail in
        detail.domain == Self.apiErrorDomain && detail.reason == "CATALOG_NOT_READY"
      }
  }

  private static func mapAuthorizationFailure(
    _ error: ConnectError
  ) -> OAuthAuthorizationClientError {
    if let exception = error.exception,
      (exception as NSError).domain == NSURLErrorDomain
    {
      return .network
    }
    switch error.code {
    case .canceled, .deadlineExceeded, .resourceExhausted, .unavailable:
      return .network

    case .ok, .unknown, .invalidArgument, .notFound, .alreadyExists, .permissionDenied,
      .failedPrecondition, .aborted, .outOfRange, .unimplemented, .internalError, .dataLoss,
      .unauthenticated:
      return .invalidResponse
    }
  }

  private static func mapHomeFailure(_ error: ConnectError) -> HomeLoadingFailure {
    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    if isCatalogNotReady(error) {
      return .catalogNotReady(retryAfterSeconds: retryDelaySeconds(error))
    }
    if error.code == .failedPrecondition,
      errorInfo.contains(where: { detail in
        detail.domain == Self.apiErrorDomain && detail.reason == "CLIENT_VERSION_UNSUPPORTED"
      })
    {
      return .incompatible
    }
    if let exception = error.exception {
      return (exception as NSError).domain == NSURLErrorDomain
        ? .networkUnavailable
        : .incompatible
    }

    switch error.code {
    case .canceled, .deadlineExceeded:
      return .networkUnavailable

    case .resourceExhausted, .unavailable:
      return .namaUnavailable(requestID: requestID(error))

    case .permissionDenied, .unauthenticated:
      return .authorizationUnavailable

    case .ok, .unknown, .invalidArgument, .notFound, .alreadyExists, .failedPrecondition,
      .aborted, .outOfRange, .unimplemented, .internalError, .dataLoss:
      return .incompatible
    }
  }

  private static func retryDelaySeconds(_ error: ConnectError) -> Int? {
    let retryInfo: [Google_Rpc_RetryInfo] = error.unpackedDetails()
    guard
      let detail = retryInfo.first(where: \.hasRetryDelay),
      detail.retryDelay.seconds >= 0,
      detail.retryDelay.nanos >= 0,
      detail.retryDelay.nanos < Self.nanosecondsPerSecond
    else {
      return nil
    }
    let roundUp = detail.retryDelay.nanos == 0 ? 0 : 1
    guard detail.retryDelay.seconds <= Int64(Int.max - roundUp) else {
      return nil
    }
    return Int(detail.retryDelay.seconds) + roundUp
  }

  static func requestID(_ error: ConnectError) -> String? {
    let requestInfo: [Google_Rpc_RequestInfo] = error.unpackedDetails()
    return requestInfo.lazy.map(\.requestID).first(where: isCanonicalRequestID)
  }

  private static func isCanonicalRequestID(_ value: String) -> Bool {
    guard
      value.utf8.count == Self.canonicalRequestIDLength,
      let normalized = UUID(uuidString: value)?.uuidString
    else {
      return false
    }
    return normalized.caseInsensitiveCompare(value) == .orderedSame
  }

  private static var currentPlatform: String {
    #if os(tvOS)
      "tvos"
    #elseif os(macOS)
      "macos"
    #else
      "ios"
    #endif
  }
}

nonisolated private final class NamaConsumerMetadataInterceptor: UnaryInterceptor, Sendable {
  private let metadata: Connect.Headers

  init(accessToken: String, clientVersion: String, platform: String) {
    metadata = [
      "authorization": ["Bearer \(accessToken)"],
      "nama-client-name": ["nama-ios"],
      "nama-client-platform": [platform],
      "nama-client-version": [clientVersion],
    ]
  }

  @Sendable
  func handleUnaryRequest<Message: ProtobufMessage>(
    _ request: HTTPRequest<Message>,
    proceed: @Sendable (Result<HTTPRequest<Message>, ConnectError>) -> Void
  ) {
    var headers = request.headers
    for (name, values) in metadata {
      headers[name] = values
    }
    proceed(
      .success(
        HTTPRequest(
          url: request.url,
          headers: headers,
          message: request.message,
          method: request.method,
          trailers: request.trailers,
          idempotencyLevel: request.idempotencyLevel
        )
      )
    )
  }
}
