import Foundation
import Network

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

  private struct FixtureResponse: Sendable {
    let status: String
    let data: Data
    let contentRange: String?
  }

  private static let minimumReceiveLength = 1
  private static let maximumRequestBytes = 65_536
  private static let rangeComponentCount = 2

  private let listener: NWListener
  private let queue = DispatchQueue(label: "com.electather.nama.tests.playback-fixture")
  private let fixtureTable: [String: Fixture]
  private let lock = NSLock()
  private var recordedRequests: [RecordedRequest] = []

  private init(listener: NWListener, fixtures: [String: Fixture]) {
    self.listener = listener
    fixtureTable = fixtures
  }

  static func start() async throws -> PlaybackFixtureServer {
    let fixtures = try loadFixtures()
    let tcpListener = try NWListener(using: .tcp, on: .any)
    let fixtureServer = PlaybackFixtureServer(listener: tcpListener, fixtures: fixtures)
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
  }

  func received(path: String, marker: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return recordedRequests.contains { request in
      request.path == path && request.headers["x-nama-fixture"] == marker
    }
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
    guard let request = String(data: requestData, encoding: .utf8) else {
      send(status: "400 Bad Request", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    let lines = request.components(separatedBy: "\r\n")
    guard
      let requestLine = lines.first,
      let methodPart = requestLine.split(separator: " ").first,
      let pathPart = requestLine.split(separator: " ").dropFirst().first
    else {
      send(status: "400 Bad Request", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    let method = String(methodPart)
    let path = String(pathPart).split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
    var headers: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let separator = line.firstIndex(of: ":") else {
        continue
      }
      let name = line[..<separator]
      let value = line[line.index(after: separator)...]
      headers[String(name).lowercased()] = value.trimmingCharacters(in: .whitespaces)
    }
    lock.lock()
    recordedRequests.append(RecordedRequest(path: path, headers: headers))
    lock.unlock()

    guard let fixture = fixtureTable[path] else {
      send(status: "404 Not Found", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    if let marker = fixture.requiredMarker, headers["x-nama-fixture"] != marker {
      send(status: "401 Unauthorized", body: Data(), contentType: "text/plain", on: connection)
      return
    }
    let fixtureResponse = Self.response(
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
    contentRange: String? = nil
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
    var response = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    response.append(body)
    connection.send(
      content: response,
      completion: .contentProcessed { _ in
        connection.cancel()
      }
    )
  }

  private static func response(for data: Data, rangeHeader: String?) -> FixtureResponse {
    guard let rangeHeader, rangeHeader.hasPrefix("bytes=") else {
      return FixtureResponse(status: "200 OK", data: data, contentRange: nil)
    }
    let values = rangeHeader.dropFirst("bytes=".count).split(
      separator: "-",
      maxSplits: 1,
      omittingEmptySubsequences: false
    )
    guard values.count == Self.rangeComponentCount else {
      return FixtureResponse(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    guard let finalByteOffset = data.indices.last else {
      return FixtureResponse(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
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
      return FixtureResponse(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    guard start >= data.startIndex, start <= end, start < data.endIndex else {
      return FixtureResponse(status: "416 Range Not Satisfiable", data: Data(), contentRange: nil)
    }
    return FixtureResponse(
      status: "206 Partial Content",
      data: data.subdata(in: start..<data.index(after: end)),
      contentRange: "bytes \(start)-\(end)/\(data.count)"
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
