import Foundation

nonisolated extension NamaPlaybackBridgeRequest {
  var isFinished: Bool {
    finishLock.lock()
    defer { finishLock.unlock() }
    return finished
  }

  func finish() {
    finishLock.lock()
    guard !finished else {
      finishLock.unlock()
      return
    }
    finished = true
    finishLock.unlock()
    completion(ObjectIdentifier(self))
  }

  func applyStoredHeaders(to request: inout URLRequest) {
    for (name, value) in resource.headers {
      request.setValue(value, forHTTPHeaderField: name)
    }
  }

  func sendFailure(status: Int) {
    guard !isFinished else {
      return
    }
    let head = [
      "HTTP/1.1 \(status) \(NamaPlaybackHTTPStatus.reason(for: status))",
      "Content-Type: text/plain",
      "Content-Length: 0",
      "Connection: close",
      "",
      "",
    ].joined(separator: "\r\n")
    sendComplete(Data(head.utf8))
    finish()
  }

  func responseHead(
    for response: HTTPURLResponse,
    contentLength: Int64
  ) -> Data {
    var headers = [
      "HTTP/1.1 \(response.statusCode) \(NamaPlaybackHTTPStatus.reason(for: response.statusCode))"
    ]
    if let contentType = response.value(forHTTPHeaderField: "Content-Type") ?? resource.mimeType {
      headers.append("Content-Type: \(contentType)")
    }
    for name in Self.forwardedResponseHeaders {
      if let value = response.value(forHTTPHeaderField: name) {
        headers.append("\(name): \(value)")
      }
    }
    if contentLength >= 0 {
      headers.append("Content-Length: \(contentLength)")
    } else if method != "HEAD" {
      headers.append("Transfer-Encoding: chunked")
    }
    headers.append("Connection: close")
    headers.append("")
    headers.append("")
    return Data(headers.joined(separator: "\r\n").utf8)
  }

  func sendPart(_ data: Data, suspending task: URLSessionDataTask? = nil) {
    guard !data.isEmpty else {
      return
    }
    task?.suspend()
    connection.send(
      content: data,
      completion: .contentProcessed { error in
        if error == nil {
          task?.resume()
        } else {
          task?.cancel()
        }
      }
    )
  }

  func sendComplete(_ data: Data?) {
    connection.send(
      content: data,
      contentContext: .finalMessage,
      isComplete: true,
      completion: .contentProcessed { _ in self.connection.cancel() }
    )
  }

  func rewritePlaylist(_ data: Data, relativeTo baseURL: URL) throws -> Data {
    guard let playlist = String(data: data, encoding: .utf8) else {
      throw NamaPlaybackHTTPBridgeError.malformedPlaylist
    }
    let lineSeparator = playlist.contains("\r\n") ? "\r\n" : "\n"
    let lines = playlist.components(separatedBy: lineSeparator)
    var nextURIIsPlaylist = false
    var rewrittenLines: [String] = []
    rewrittenLines.reserveCapacity(lines.count)
    for line in lines {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      guard !trimmed.isEmpty else {
        rewrittenLines.append(line)
        continue
      }
      if trimmed.hasPrefix("#") {
        rewrittenLines.append(try rewriteURIAttributes(in: line, relativeTo: baseURL))
        nextURIIsPlaylist = trimmed.hasPrefix("#EXT-X-STREAM-INF:")
        continue
      }
      let contentKind: NamaPlaybackBridgeContentKind = nextURIIsPlaylist ? .playlist : .unknown
      rewrittenLines.append(
        try localURL(for: trimmed, relativeTo: baseURL, contentKind: contentKind).absoluteString
      )
      nextURIIsPlaylist = false
    }
    return Data(rewrittenLines.joined(separator: lineSeparator).utf8)
  }

  func rewriteURIAttributes(in line: String, relativeTo baseURL: URL) throws -> String {
    var rewritten = line
    var searchStart = rewritten.startIndex
    let contentKind = Self.uriAttributeContentKind(for: line)
    while let marker = rewritten.range(of: "URI=\"", range: searchStart..<rewritten.endIndex) {
      let valueStart = marker.upperBound
      guard let valueEnd = rewritten[valueStart...].firstIndex(of: "\"") else {
        throw NamaPlaybackHTTPBridgeError.malformedPlaylist
      }
      let value = String(rewritten[valueStart..<valueEnd])
      let replacement = try localURL(
        for: value,
        relativeTo: baseURL,
        contentKind: contentKind
      ).absoluteString
      rewritten.replaceSubrange(valueStart..<valueEnd, with: replacement)
      searchStart = rewritten.index(valueStart, offsetBy: replacement.count)
    }
    return rewritten
  }

  func localURL(
    for value: String,
    relativeTo baseURL: URL,
    contentKind: NamaPlaybackBridgeContentKind
  ) throws -> URL {
    guard
      let upstreamURL = URL(string: value, relativeTo: baseURL)?.absoluteURL,
      resource.allows(upstreamURL)
    else {
      throw NamaPlaybackHTTPBridgeError.destinationNotAllowed
    }
    return try register(
      NamaPlaybackBridgeResource(
        scopeID: resource.scopeID,
        url: upstreamURL,
        headers: resource.headers,
        allowedOrigins: resource.allowedOrigins,
        mimeType: nil,
        expiresAt: resource.expiresAt,
        contentKind: contentKind
      )
    )
  }

  static func uriAttributeContentKind(for line: String) -> NamaPlaybackBridgeContentKind {
    if line.hasPrefix("#EXT-X-MEDIA:")
      || line.hasPrefix("#EXT-X-I-FRAME-STREAM-INF:")
      || line.hasPrefix("#EXT-X-IMAGE-STREAM-INF:")
      || line.hasPrefix("#EXT-X-RENDITION-REPORT:")
    {
      return .playlist
    }
    return .unknown
  }

  static func isLikelyPlaylist(_ resource: NamaPlaybackBridgeResource) -> Bool {
    let mimeType = resource.mimeType?.lowercased() ?? ""
    return resource.contentKind == .playlist
      || resource.url.pathExtension.lowercased() == "m3u8"
      || mimeType.contains("mpegurl")
  }

  static func isPlaylist(
    resource: NamaPlaybackBridgeResource,
    response: HTTPURLResponse
  ) -> Bool {
    let responseType = response.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
    return isLikelyPlaylist(resource) || responseType.contains("mpegurl")
  }

  static func chunk(_ data: Data) -> Data {
    var chunk = Data(String(data.count, radix: hexadecimalRadix).utf8)
    chunk.append(Data("\r\n".utf8))
    chunk.append(data)
    chunk.append(Data("\r\n".utf8))
    return chunk
  }
}
