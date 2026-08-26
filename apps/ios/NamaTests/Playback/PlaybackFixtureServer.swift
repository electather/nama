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

nonisolated private struct PlaybackFixtureResponse: Sendable {
  private static let rangeComponentCount = 2

  let status: String
  let data: Data
  let contentRange: String?

  static func make(for data: Data, rangeHeader: String?) -> Self {
    guard let rangeHeader, rangeHeader.hasPrefix("bytes=") else {
      return Self(status: "200 OK", data: data, contentRange: nil)
    }
    let values = rangeHeader.dropFirst("bytes=".count).split(
      separator: "-",
      maxSplits: 1,
      omittingEmptySubsequences: false
    )
    guard values.count == Self.rangeComponentCount else {
      return Self(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    guard let finalByteOffset = data.indices.last else {
      return Self(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
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
      return Self(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    guard start >= data.startIndex, start <= end, start < data.endIndex else {
      return Self(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    return Self(
      status: "206 Partial Content",
      data: data.subdata(in: start..<data.index(after: end)),
      contentRange: "bytes \(start)-\(end)/\(data.count)"
    )
  }
}

nonisolated private final class PlaybackFixtureRequestRecorder: @unchecked Sendable {
  private struct Waiter {
    let path: String
    let marker: String?
    let continuation: CheckedContinuation<Bool, Never>
  }

  private let lock = NSLock()
  private var requests: [PlaybackFixtureServer.RecordedRequest] = []
  private var waiters: [Waiter] = []
  private var stopped = false

  func record(_ request: PlaybackFixtureServer.RecordedRequest) {
    lock.lock()
    requests.append(request)
    var matched: [CheckedContinuation<Bool, Never>] = []
    waiters.removeAll { waiter in
      guard Self.matches(request, path: waiter.path, marker: waiter.marker) else {
        return false
      }
      matched.append(waiter.continuation)
      return true
    }
    lock.unlock()
    for continuation in matched {
      continuation.resume(returning: true)
    }
  }

  func received(path: String, marker: String? = nil) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return requests.contains { Self.matches($0, path: path, marker: marker) }
  }

  func waitUntilReceived(path: String, marker: String? = nil) async -> Bool {
    await withCheckedContinuation { continuation in
      lock.lock()
      if stopped {
        lock.unlock()
        continuation.resume(returning: false)
      } else if requests.contains(where: { Self.matches($0, path: path, marker: marker) }) {
        lock.unlock()
        continuation.resume(returning: true)
      } else {
        waiters.append(Waiter(path: path, marker: marker, continuation: continuation))
        lock.unlock()
      }
    }
  }

  func stop() {
    lock.lock()
    stopped = true
    let pending = waiters.map(\.continuation)
    waiters.removeAll()
    lock.unlock()
    for continuation in pending {
      continuation.resume(returning: false)
    }
  }

  private static func matches(
    _ request: PlaybackFixtureServer.RecordedRequest,
    path: String,
    marker: String?
  ) -> Bool {
    request.path == path
      && (marker.map { request.headers["x-nama-fixture"] == $0 } ?? true)
  }
}

nonisolated final class PlaybackFixtureServer: @unchecked Sendable {
  struct RecordedRequest: Sendable {
    let path: String
    let headers: [String: String]
  }

  private struct Fixture: Sendable {
    let contentType: String
    let data: Data
    let requiredMarker: String?
  }

  private static let minimumReceiveLength = 1
  private static let maximumRequestBytes = 65_536

  private let listener: NWListener
  private let queue = DispatchQueue(label: "com.electather.nama.tests.playback-fixture")
  private let fixtureTable: [String: Fixture]
  private let redirects: [String: URL]
  private let requestRecorder = PlaybackFixtureRequestRecorder()

  private init(listener: NWListener, fixtures: [String: Fixture], redirects: [String: URL]) {
    self.listener = listener
    fixtureTable = fixtures
    self.redirects = redirects
  }

  static func start(
    redirects: [String: URL] = [:]
  ) async throws -> PlaybackFixtureServer {
    let fixtures = try loadFixtures()
    let tcpListener = try NWListener(using: .tcp, on: .any)
    let fixtureServer = PlaybackFixtureServer(
      listener: tcpListener,
      fixtures: fixtures,
      redirects: redirects
    )
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

  private static func loadFixtures() throws -> [String: Fixture] {
    let bundle = Bundle(for: PlaybackFixtureBundleToken.self)
    return try [
      "/sdr-master.m3u8": Fixture(
        contentType: "application/vnd.apple.mpegurl",
        data: resource(named: "sdr-master", extension: "m3u8", bundle: bundle),
        requiredMarker: "media"
      ),
      "/sdr-segment.ts": Fixture(
        contentType: "video/mp2t",
        data: resource(named: "sdr-segment", extension: "ts", bundle: bundle),
        requiredMarker: "media"
      ),
      "/track-controls.mkv": Fixture(
        contentType: "video/x-matroska",
        data: resource(named: "track-controls", extension: "mkv", bundle: bundle),
        requiredMarker: "media"
      ),
      "/subtitle.srt": Fixture(
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
    listener.cancel()
    requestRecorder.stop()
  }

  func received(path: String, marker: String) -> Bool {
    requestRecorder.received(path: path, marker: marker)
  }

  func received(path: String) -> Bool { requestRecorder.received(path: path) }

  func waitUntilReceived(path: String, marker: String? = nil) async -> Bool {
    await requestRecorder.waitUntilReceived(path: path, marker: marker)
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
    requestRecorder.record(RecordedRequest(path: path, headers: headers))

    if let redirect = redirects[path] {
      send(
        status: "302 Found",
        body: Data(),
        contentType: "text/plain",
        on: connection,
        additionalHeaders: ["Location": redirect.absoluteString]
      )
      return
    }

    guard let fixture = fixtureTable[path] else {
      send(status: "404 Not Found", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    if let marker = fixture.requiredMarker, headers["x-nama-fixture"] != marker {
      send(status: "401 Unauthorized", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    let fixtureResponse = PlaybackFixtureResponse.make(
      for: fixture.data,
      rangeHeader: headers["range"]
    )
    send(
      status: fixtureResponse.status,
      body: method == "HEAD" ? Data() : fixtureResponse.data,
      contentType: fixture.contentType,
      on: connection,
      contentLength: fixtureResponse.data.count,
      contentRange: fixtureResponse.contentRange
    )
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
