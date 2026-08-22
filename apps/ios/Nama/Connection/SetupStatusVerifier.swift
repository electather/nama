import Connect
import Foundation
import NamaAPI

nonisolated struct NamaSetupStatusVerifier: ConnectionVerifying {
  private let sessionConfiguration: URLSessionConfiguration
  private let clientVersion: String
  private let platform: String

  private static let requestTimeout: TimeInterval = 10

  init(
    clientVersion: String,
    sessionConfiguration: URLSessionConfiguration = .default,
    platform: String = Self.currentPlatform
  ) {
    self.sessionConfiguration = sessionConfiguration
    self.clientVersion = clientVersion
    self.platform = platform
  }

  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult {
    let transport = URLSessionHTTPClient(configuration: sessionConfiguration)
    let protocolClient = ProtocolClient(
      httpClient: transport,
      config: ProtocolClientConfig(
        host: endpoint.absoluteString,
        networkProtocol: .connect,
        timeout: Self.requestTimeout,
        interceptors: [
          InterceptorFactory { _ in
            ClientMetadataInterceptor(clientVersion: clientVersion, platform: platform)
            // swiftlint:disable:next trailing_comma
          }
        ]
      )
    )
    let client = Nama_Api_V1_SetupServiceClient(client: protocolClient)
    let response = await client.getStatus(request: Nama_Api_V1_GetStatusRequest())

    if Task.isCancelled {
      return .cancelled
    }
    switch response.result {
    case .success(let status):
      return status.initialized ? .ready : .setupRequired

    case .failure(let error):
      return Self.map(error)
    }
  }

  private static func map(_ error: ConnectError) -> ConnectionVerificationResult {
    if error.code == .canceled {
      return .failure(.cannotConnect)
    }
    if error.code == .deadlineExceeded {
      return .failure(.cannotConnect)
    }
    if let exception = error.exception {
      let cocoaError = exception as NSError
      return cocoaError.domain == NSURLErrorDomain
        ? .failure(.cannotConnect)
        : .failure(.incompatible)
    }

    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    if errorInfo.contains(where: { $0.reason == "CLIENT_VERSION_UNSUPPORTED" }) {
      return .failure(.incompatible)
    }

    switch error.code {
    case .unavailable, .resourceExhausted:
      return .failure(.namaUnavailable)

    case .ok, .canceled, .unknown, .invalidArgument, .deadlineExceeded, .notFound,
      .alreadyExists, .permissionDenied, .failedPrecondition, .aborted, .outOfRange,
      .unimplemented, .internalError, .dataLoss, .unauthenticated:
      return .failure(.incompatible)
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

nonisolated private final class ClientMetadataInterceptor: UnaryInterceptor, Sendable {
  private let metadata: Connect.Headers

  init(clientVersion: String, platform: String) {
    self.metadata = [
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
