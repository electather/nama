import Foundation
import Network

nonisolated enum NamaPlaybackHTTPBridgeError: Error, Sendable {
  case invalidLocator
  case destinationNotAllowed
  case malformedPlaylist
}

nonisolated enum NamaPlaybackBridgeContentKind: Sendable, Hashable {
  case unknown
  case playlist
}

nonisolated struct NamaPlaybackBridgeResource: Sendable {
  let scopeID: UUID
  let url: URL
  let headers: [String: String]
  let allowedOrigins: Set<NamaPlaybackOrigin>
  let mimeType: String?
  let expiresAt: Date
  let contentKind: NamaPlaybackBridgeContentKind

  func allows(_ destination: URL) -> Bool {
    NamaPlaybackOrigin(destination: destination).map(allowedOrigins.contains) ?? false
  }
}

nonisolated struct NamaPlaybackBridgeResourceKey: Hashable {
  let scopeID: UUID
  let url: URL
  let contentKind: NamaPlaybackBridgeContentKind
}
nonisolated struct NamaPlaybackBridgeLocalRequest {
  let method: String
  let path: String
  let headers: [String: String]
}

nonisolated enum NamaPlaybackHTTPStatus {
  static let okay = 200
  static let partialContent = 206
  static let badRequest = 400
  static let forbidden = 403
  static let notFound = 404
  static let methodNotAllowed = 405
  static let rangeNotSatisfiable = 416
  static let internalServerError = 500
  static let badGateway = 502
  static let serviceUnavailable = 503
  static let redirectRange = 300..<400

  private static let reasons = [
    okay: "OK",
    partialContent: "Partial Content",
    badRequest: "Bad Request",
    forbidden: "Forbidden",
    notFound: "Not Found",
    methodNotAllowed: "Method Not Allowed",
    rangeNotSatisfiable: "Range Not Satisfiable",
    internalServerError: "Internal Server Error",
    badGateway: "Bad Gateway",
    serviceUnavailable: "Service Unavailable",
  ]

  static func reason(for status: Int) -> String {
    reasons[status] ?? "Upstream Response"
  }
}

nonisolated final class NamaPlaybackHTTPBridge: @unchecked Sendable {
  static let minimumReceiveLength = 1
  static let maximumRequestBytes = 65_536

  let listener: NWListener
  let queue = DispatchQueue(label: "com.electather.nama.playback-http-bridge")
  let lock = NSLock()
  var resources: [String: NamaPlaybackBridgeResource] = [:]
  var pathsByResource: [NamaPlaybackBridgeResourceKey: String] = [:]
  var handlers: [ObjectIdentifier: NamaPlaybackBridgeRequest] = [:]
  var acceptedConnections: [ObjectIdentifier: NWConnection] = [:]
  var stopped = false

  private init(listener: NWListener) {
    self.listener = listener
  }

  static func start() async throws -> NamaPlaybackHTTPBridge {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let tcpListener = try NWListener(using: parameters, on: .any)
    let playbackBridge = NamaPlaybackHTTPBridge(listener: tcpListener)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let resumed = NamaPlaybackContinuationClaim()
        tcpListener.stateUpdateHandler = { state in
          switch state {
          case .ready:
            guard resumed.claim() else {
              return
            }
            continuation.resume(returning: playbackBridge)

          case .failed(let error):
            guard resumed.claim() else {
              return
            }
            continuation.resume(throwing: error)

          case .cancelled:
            guard resumed.claim() else {
              return
            }
            continuation.resume(throwing: CancellationError())

          default:
            break
          }
        }
        tcpListener.newConnectionHandler = { connection in
          playbackBridge.accept(connection)
        }
        tcpListener.start(queue: playbackBridge.queue)
      }
    } onCancel: {
      tcpListener.cancel()
    }
  }

  func prepare(_ request: NamaPlayerRequest) throws -> NamaPlayerRequest {
    let media = try register(request.media)
    let subtitles = try request.externalSubtitles.map { subtitle in
      NamaExternalSubtitleLocator(
        trackID: subtitle.trackID,
        label: subtitle.label,
        language: subtitle.language,
        isDefault: subtitle.isDefault,
        isForced: subtitle.isForced,
        isHearingImpaired: subtitle.isHearingImpaired,
        locator: try register(subtitle.locator)
      )
    }
    return NamaPlayerRequest(
      media: media,
      resumePosition: request.resumePosition,
      externalSubtitles: subtitles
    )
  }

  func stop() {
    lock.lock()
    guard !stopped else {
      lock.unlock()
      return
    }
    stopped = true
    let activeHandlers = Array(handlers.values)
    let partialConnections = Array(acceptedConnections.values)
    handlers.removeAll()
    acceptedConnections.removeAll()
    resources.removeAll()
    pathsByResource.removeAll()
    lock.unlock()

    listener.cancel()
    for connection in partialConnections {
      connection.cancel()
    }
    for handler in activeHandlers {
      handler.cancel()
    }
  }

  var origin: URL {
    guard
      let listenerPort = listener.port,
      let originURL = URL(string: "http://127.0.0.1:\(listenerPort.rawValue)")
    else {
      preconditionFailure("A ready playback bridge must have a loopback origin")
    }
    return originURL
  }

  func localURL(for resource: NamaPlaybackBridgeResource) throws -> URL {
    let key = NamaPlaybackBridgeResourceKey(
      scopeID: resource.scopeID,
      url: resource.url,
      contentKind: resource.contentKind
    )
    lock.lock()
    defer { lock.unlock() }
    guard !stopped else {
      throw CancellationError()
    }
    if let path = pathsByResource[key] {
      guard let localURL = URL(string: path, relativeTo: origin)?.absoluteURL else {
        throw NamaPlaybackHTTPBridgeError.invalidLocator
      }
      return localURL
    }

    let pathExtension = resource.url.pathExtension.lowercased()
      .filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
    let suffix = pathExtension.isEmpty ? "" : ".\(pathExtension)"
    let path = "/resource/\(UUID().uuidString)\(suffix)"
    resources[path] = resource
    pathsByResource[key] = path
    guard let localURL = URL(string: path, relativeTo: origin)?.absoluteURL else {
      throw NamaPlaybackHTTPBridgeError.invalidLocator
    }
    return localURL
  }

  private func register(_ locator: NamaPlaybackLocator) throws -> NamaPlaybackLocator {
    let allowedOriginValues = try locator.allowedRedirectOrigins.map { allowedURL in
      guard let allowedOrigin = NamaPlaybackOrigin(allowedOrigin: allowedURL) else {
        throw NamaPlaybackHTTPBridgeError.invalidLocator
      }
      return allowedOrigin
    }
    let allowedOrigins = Set(allowedOriginValues)
    let bridgeResource = NamaPlaybackBridgeResource(
      scopeID: UUID(),
      url: locator.url,
      headers: locator.headerFields,
      allowedOrigins: allowedOrigins,
      mimeType: locator.mimeType,
      expiresAt: locator.expiresAt,
      contentKind: .unknown
    )
    guard bridgeResource.allows(locator.url) else {
      throw NamaPlaybackHTTPBridgeError.destinationNotAllowed
    }
    let bridgedURL = try localURL(for: bridgeResource)
    return NamaPlaybackLocator(
      url: bridgedURL,
      headers: [],
      allowedRedirectOrigins: [origin],
      mimeType: locator.mimeType,
      expiresAt: locator.expiresAt
    )
  }
}

nonisolated final class NamaPlaybackContinuationClaim: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !claimed else {
      return false
    }
    claimed = true
    return true
  }
}
