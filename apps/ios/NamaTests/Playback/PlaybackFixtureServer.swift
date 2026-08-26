import Foundation
import Network

nonisolated private struct PlaybackFixtureRequest {
  let method: String
  let path: String
  let headers: [String: String]

  init?(_ data: Data) {
    guard let request = String(data: data, encoding: .utf8) else {
      return nil
    }
    let lines = request.components(separatedBy: "\r\n")
    guard
      let requestLine = lines.first,
      let methodPart = requestLine.split(separator: " ").first,
      let pathPart = requestLine.split(separator: " ").dropFirst().first
    else {
      return nil
    }
    method = String(methodPart)
    path = String(pathPart).split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
    var parsedHeaders: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let separator = line.firstIndex(of: ":") else {
        continue
      }
      let name = line[..<separator]
      let value = line[line.index(after: separator)...]
      parsedHeaders[String(name).lowercased()] = value.trimmingCharacters(in: .whitespaces)
    }
    headers = parsedHeaders
  }
}

nonisolated private struct PlaybackFixtureRecordedRequest: Sendable {
  let path: String
  let headers: [String: String]
}

nonisolated enum PlaybackFixtureRoute: Sendable {
  case content(contentType: String, data: Data, requiredMarker: String?)
  case redirect(location: URL, requiredMarker: String?)
  case stall(requiredMarker: String?)

  static func playlist(_ contents: String, requiredMarker: String = "media") -> Self {
    .content(
      contentType: "application/vnd.apple.mpegurl",
      data: Data(contents.utf8),
      requiredMarker: requiredMarker
    )
  }
}

nonisolated private struct PlaybackFixtureResponse: Sendable {
  let status: String
  let data: Data
  let contentRange: String?
}

nonisolated private let kPlaybackFixtureRangeComponentCount = 2

nonisolated private func playbackFixtureResponse(
  for data: Data,
  rangeHeader: String?
) -> PlaybackFixtureResponse {
  guard let rangeHeader, rangeHeader.hasPrefix("bytes=") else {
    return PlaybackFixtureResponse(status: "200 OK", data: data, contentRange: nil)
  }
  let values = rangeHeader.dropFirst("bytes=".count).split(
    separator: "-",
    maxSplits: 1,
    omittingEmptySubsequences: false
  )
  guard values.count == kPlaybackFixtureRangeComponentCount else {
    return PlaybackFixtureResponse(
      status: "416 Range Not Satisfiable",
      data: Data(),
      contentRange: nil
    )
  }
  guard let finalByteOffset = data.indices.last else {
    return PlaybackFixtureResponse(
      status: "416 Range Not Satisfiable",
      data: Data(),
      contentRange: nil
    )
  }
  let start: Int
  let end: Int
  if values[0].isEmpty, let suffixLength = Int(values[1]), suffixLength > 0 {
    start = max(data.startIndex, data.endIndex - suffixLength)
    end = finalByteOffset
  } else if let parsedStart = Int(values[0]) {
    start = parsedStart
    end = min(Int(values[1]) ?? finalByteOffset, finalByteOffset)
  } else {
    return PlaybackFixtureResponse(
      status: "416 Range Not Satisfiable",
      data: Data(),
      contentRange: nil
    )
  }
  guard start >= data.startIndex, start <= end, start < data.endIndex else {
    return PlaybackFixtureResponse(
      status: "416 Range Not Satisfiable",
      data: Data(),
      contentRange: nil
    )
  }
  return PlaybackFixtureResponse(
    status: "206 Partial Content",
    data: data.subdata(in: start..<data.index(after: end)),
    contentRange: "bytes \(start)-\(end)/\(data.count)"
  )
}

nonisolated final class PlaybackFixtureServer: @unchecked Sendable {
  private static let minimumReceiveLength = 1
  private static let maximumRequestBytes = 65_536

  private let listener: NWListener
  private let queue = DispatchQueue(label: "com.electather.nama.tests.playback-fixture")
  private let routeTable: [String: PlaybackFixtureRoute]
  private let lock = NSLock()
  private var recordedRequests: [PlaybackFixtureRecordedRequest] = []
  private var stalledConnections: [NWConnection] = []

  private init(listener: NWListener, routes: [String: PlaybackFixtureRoute]) {
    self.listener = listener
    routeTable = routes
  }

  static func start(
    routes: [String: PlaybackFixtureRoute] = [:]
  ) async throws -> PlaybackFixtureServer {
    let loadedRoutes = try loadRoutes().merging(routes) { _, supplied in supplied }
    let tcpListener = try NWListener(using: .tcp, on: .any)
    let fixtureServer = PlaybackFixtureServer(listener: tcpListener, routes: loadedRoutes)
    return try await withCheckedThrowingContinuation { continuation in
      let resumed = LockedFlag()
      tcpListener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          guard resumed.claim() else {
            return
          }
          continuation.resume(returning: fixtureServer)

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
      tcpListener.newConnectionHandler = fixtureServer.accept
      tcpListener.start(queue: fixtureServer.queue)
    }
  }

  private static func loadRoutes() throws -> [String: PlaybackFixtureRoute] {
    let bundle = Bundle(for: PlaybackFixtureBundleToken.self)
    return try [
      "/sdr-master.m3u8": .content(
        contentType: "application/vnd.apple.mpegurl",
        data: resource(named: "sdr-master", extension: "m3u8", bundle: bundle),
        requiredMarker: "media"
      ),
      "/sdr-segment.ts": .content(
        contentType: "video/mp2t",
        data: resource(named: "sdr-segment", extension: "ts", bundle: bundle),
        requiredMarker: "media"
      ),
      "/track-controls.mkv": .content(
        contentType: "video/x-matroska",
        data: resource(named: "track-controls", extension: "mkv", bundle: bundle),
        requiredMarker: "media"
      ),
      "/subtitle.srt": .content(
        contentType: "application/x-subrip",
        data: resource(named: "subtitle", extension: "srt", bundle: bundle),
        requiredMarker: "subtitle"
      ),
    ]
  }

  var origin: URL {
    guard
      let port = listener.port,
      let originURL = URL(string: "http://127.0.0.1:\(port.rawValue)")
    else {
      preconditionFailure("A ready fixture listener must have a valid port")
    }
    return originURL
  }

  func stop() {
    lock.lock()
    let connections = stalledConnections
    stalledConnections.removeAll(keepingCapacity: false)
    lock.unlock()
    listener.cancel()
    for connection in connections {
      connection.cancel()
    }
  }

  func received(path: String, marker: String? = nil) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests.contains { request in
      request.path == path
        && marker.map { request.headers["x-nama-fixture"] == $0 } != false
    }
  }

  func requestCount(path: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests.count { $0.path == path }
  }

  func receivedHeader(path: String, name: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests.last { $0.path == path }?.headers[name.lowercased()]
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(on: connection, accumulated: Data())
  }

  private func receive(on connection: NWConnection, accumulated: Data) {
    connection.receive(
      minimumIncompleteLength: Self.minimumReceiveLength,
      maximumLength: Self.maximumRequestBytes
    ) { [weak self] data, contentContext, isComplete, error in
      _ = contentContext
      guard let self else {
        connection.cancel()
        return
      }
      var request = accumulated
      if let data {
        request.append(data)
      }
      if String(bytes: request, encoding: .utf8)?.contains("\r\n\r\n") == true {
        respond(to: request, on: connection)
      } else if isComplete || error != nil || request.count >= Self.maximumRequestBytes {
        connection.cancel()
      } else {
        receive(on: connection, accumulated: request)
      }
    }
  }

  private func respond(to requestData: Data, on connection: NWConnection) {
    guard let request = PlaybackFixtureRequest(requestData) else {
      send(status: "400 Bad Request", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    let method = request.method
    let path = request.path
    let headers = request.headers
    lock.lock()
    recordedRequests.append(PlaybackFixtureRecordedRequest(path: path, headers: headers))
    lock.unlock()

    guard let route = routeTable[path] else {
      send(status: "404 Not Found", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    respond(to: route, method: method, headers: headers, on: connection)
  }

  private func respond(
    to route: PlaybackFixtureRoute,
    method: String,
    headers: [String: String],
    on connection: NWConnection
  ) {
    switch route {
    case .content(let contentType, let data, let requiredMarker):
      guard requiredMarker == nil || headers["x-nama-fixture"] == requiredMarker else {
        send(status: "401 Unauthorized", body: Data(), contentType: "text/plain", on: connection)
        return
      }
      let fixtureResponse = playbackFixtureResponse(for: data, rangeHeader: headers["range"])
      send(
        status: fixtureResponse.status,
        body: method == "HEAD" ? Data() : fixtureResponse.data,
        contentType: contentType,
        on: connection,
        contentLength: fixtureResponse.data.count,
        contentRange: fixtureResponse.contentRange
      )

    case .redirect(let location, let requiredMarker):
      guard requiredMarker == nil || headers["x-nama-fixture"] == requiredMarker else {
        send(status: "401 Unauthorized", body: Data(), contentType: "text/plain", on: connection)
        return
      }
      send(
        status: "302 Found",
        body: Data(),
        contentType: "text/plain",
        on: connection,
        additionalHeaders: ["Location": location.absoluteString]
      )

    case .stall(let requiredMarker):
      guard requiredMarker == nil || headers["x-nama-fixture"] == requiredMarker else {
        send(status: "401 Unauthorized", body: Data(), contentType: "text/plain", on: connection)
        return
      }
      lock.lock()
      stalledConnections.append(connection)
      lock.unlock()
    }
  }

  private func send(
    status: String,
    body: Data,
    contentType: String,
    on connection: NWConnection,
    contentLength: Int? = nil,
    contentRange: String? = nil,
    additionalHeaders: [String: String] = [:]
  ) {
    var headers = [
      "HTTP/1.1 \(status)",
      "Content-Type: \(contentType)",
      "Content-Length: \(contentLength ?? body.count)",
      "Accept-Ranges: bytes",
      "Connection: close",
    ]
    if let contentRange {
      headers.append("Content-Range: \(contentRange)")
    }
    for (name, value) in additionalHeaders.sorted(by: { $0.key < $1.key }) {
      headers.append("\(name): \(value)")
    }
    var response = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    response.append(body)
    connection.send(
      content: response,
      completion: .contentProcessed { _ in
        connection.cancel()
      }
    )
  }

  private static func resource(named name: String, extension fileExtension: String, bundle: Bundle)
    throws -> Data
  {
    guard let url = bundle.url(forResource: name, withExtension: fileExtension) else {
      throw CocoaError(.fileNoSuchFile)
    }
    return try Data(contentsOf: url)
  }
}

nonisolated private final class PlaybackFixtureBundleToken: NSObject {}

nonisolated private final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !value else {
      return false
    }
    value = true
    return true
  }
}
