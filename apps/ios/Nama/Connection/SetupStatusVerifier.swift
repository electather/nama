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
    let transport = NamaUnaryURLSessionHTTPClient(configuration: sessionConfiguration)
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

nonisolated final class NamaUnaryURLSessionHTTPClient: HTTPClientInterface, @unchecked Sendable {
  private let session: URLSession

  init(configuration: URLSessionConfiguration) {
    session = URLSession(configuration: configuration)
  }

  deinit {
    session.finishTasksAndInvalidate()
  }

  @discardableResult
  func unary(
    request: HTTPRequest<Data?>,
    onMetrics: @escaping @Sendable (HTTPMetrics) -> Void,
    onResponse: @escaping @Sendable (HTTPResponse) -> Void
  ) -> Cancelable {
    let delegate = NoRedirect(onMetrics: onMetrics)
    let task = session.dataTask(with: Self.urlRequest(from: request)) { data, response, error in
      if let redirectResponse = delegate.refusedResponse {
        onResponse(Self.refusedRedirectResponse(redirectResponse))
      } else {
        onResponse(Self.httpResponse(data: data, response: response, error: error))
      }
    }
    task.delegate = delegate
    task.resume()
    return Cancelable { task.cancel() }
  }

  func stream(
    request _: HTTPRequest<Data?>,
    responseCallbacks: ResponseCallbacks
  ) -> RequestCallbacks<Data> {
    responseCallbacks.receiveClose(
      .unimplemented,
      [:],
      ConnectError(code: .unimplemented, message: nil)
    )
    return RequestCallbacks(
      cancel: {
        // The stream is already closed.
      },
      sendData: { _ in
        // The stream is already closed.
      },
      sendClose: {
        // The stream is already closed.
      }
    )
  }

  private static func urlRequest(from request: HTTPRequest<Data?>) -> URLRequest {
    var urlRequest = URLRequest(url: request.url)
    urlRequest.httpMethod = request.method.rawValue
    urlRequest.httpBody = request.message
    for (name, values) in request.headers {
      urlRequest.setValue(values.joined(separator: ","), forHTTPHeaderField: name)
    }
    return urlRequest
  }

  private static func httpResponse(
    data: Data?,
    response: URLResponse?,
    error: (any Error)?
  ) -> HTTPResponse {
    if let httpResponse = response as? HTTPURLResponse {
      return HTTPResponse(
        code: Code.fromHTTPStatus(httpResponse.statusCode),
        headers: headers(from: httpResponse),
        message: data,
        trailers: [:],
        error: error,
        tracingInfo: .init(httpStatus: httpResponse.statusCode)
      )
    }
    if let error {
      let code = code(for: error)
      return HTTPResponse(
        code: code,
        headers: [:],
        message: data,
        trailers: [:],
        error: ConnectError(code: code, message: nil, exception: error),
        tracingInfo: nil
      )
    }
    return HTTPResponse(
      code: .unknown,
      headers: [:],
      message: data,
      trailers: [:],
      error: ConnectError(code: .unknown, message: nil),
      tracingInfo: nil
    )
  }

  private static func refusedRedirectResponse(_ response: HTTPURLResponse) -> HTTPResponse {
    HTTPResponse(
      code: .unknown,
      headers: headers(from: response),
      message: nil,
      trailers: [:],
      error: nil,
      tracingInfo: .init(httpStatus: response.statusCode)
    )
  }

  private static func headers(from response: HTTPURLResponse) -> Connect.Headers {
    response.allHeaderFields.reduce(into: Connect.Headers()) { headers, field in
      guard
        let name = (field.key as? String)?.lowercased(),
        name != "location"
      else {
        return
      }
      let values = field.value as? String ?? String(describing: field.value)
      for value in values.components(separatedBy: ",") {
        headers[name, default: []].append(value.trimmingCharacters(in: .whitespaces))
      }
    }
  }

  private static func code(for error: any Error) -> Code {
    guard let urlError = error as? URLError else {
      return .unknown
    }
    switch urlError.code {
    case .cancelled:
      return .canceled

    case .badURL:
      return .invalidArgument

    case .timedOut:
      return .deadlineExceeded

    case .unsupportedURL:
      return .unimplemented

    case .cannotConnectToHost, .cannotFindHost, .dataNotAllowed, .internationalRoamingOff,
      .networkConnectionLost, .notConnectedToInternet, .secureConnectionFailed:
      return .unavailable

    default:
      return .unknown
    }
  }
}

nonisolated private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  private let onMetrics: @Sendable (HTTPMetrics) -> Void
  private let lock = NSLock()
  private var redirectResponse: HTTPURLResponse?

  var refusedResponse: HTTPURLResponse? {
    lock.withLock { redirectResponse }
  }

  init(onMetrics: @escaping @Sendable (HTTPMetrics) -> Void) {
    self.onMetrics = onMetrics
  }

  func urlSession(
    _: URLSession,
    task _: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest _: URLRequest,
    completionHandler: @Sendable (URLRequest?) -> Void
  ) {
    lock.withLock {
      redirectResponse = response
    }
    completionHandler(nil)
  }

  func urlSession(
    _: URLSession,
    task _: URLSessionTask,
    didFinishCollecting metrics: URLSessionTaskMetrics
  ) {
    onMetrics(HTTPMetrics(taskMetrics: metrics))
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
