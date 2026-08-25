import Connect
import Foundation
import NamaAPI

nonisolated struct NamaOAuthScopedAccessVerifier: OAuthScopedAccessVerifying {
  private let clientVersion: String
  private let platform: String
  private let sessionConfiguration: URLSessionConfiguration

  private static let requestTimeout: TimeInterval = 10

  init(
    clientVersion: String,
    sessionConfiguration: URLSessionConfiguration = .default,
    platform: String = Self.currentPlatform
  ) {
    self.clientVersion = clientVersion
    self.sessionConfiguration = sessionConfiguration
    self.platform = platform
  }

  func verify(_ record: EndpointBoundOAuthTokenRecord) async throws {
    let transport = NamaUnaryURLSessionHTTPClient(
      endpoint: record.endpoint,
      configuration: sessionConfiguration
    )
    let metadataInterceptor = InterceptorFactory { _ in
      OAuthConsumerMetadataInterceptor(
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
    let client = Nama_Api_V1_LibraryServiceClient(client: protocolClient)
    let response = await client.getHome(request: Nama_Api_V1_GetHomeRequest())

    if Task.isCancelled {
      throw CancellationError()
    }
    switch response.result {
    case .success:
      return

    case .failure(let error) where error.code == .unimplemented:
      // Authorization runs before the deliberately unimplemented library handler.
      return

    case .failure(let error):
      throw Self.map(error)
    }
  }

  private static func map(_ error: ConnectError) -> OAuthAuthorizationClientError {
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

nonisolated private final class OAuthConsumerMetadataInterceptor: UnaryInterceptor, Sendable {
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
