import Foundation
import Network

nonisolated extension NamaPlaybackHTTPBridge {
  func accept(_ connection: NWConnection) {
    let identifier = ObjectIdentifier(connection)
    lock.lock()
    guard !stopped else {
      lock.unlock()
      connection.cancel()
      return
    }
    acceptedConnections[identifier] = connection
    lock.unlock()
    connection.start(queue: queue)
    receive(on: connection, accumulated: Data())
  }

  private func receive(on connection: NWConnection, accumulated: Data) {
    connection.receive(
      minimumIncompleteLength: Self.minimumReceiveLength,
      maximumLength: Self.maximumRequestBytes
    ) { [weak self] data, _, isComplete, error in
      guard let self else {
        connection.cancel()
        return
      }
      var requestData = accumulated
      if let data {
        requestData.append(data)
      }
      if String(data: requestData, encoding: .utf8)?.contains("\r\n\r\n") == true {
        handle(requestData, on: connection)
      } else if isComplete || error != nil || requestData.count >= Self.maximumRequestBytes {
        removeAcceptedConnection(connection)
        connection.cancel()
      } else {
        receive(on: connection, accumulated: requestData)
      }
    }
  }

  private func handle(_ requestData: Data, on connection: NWConnection) {
    guard let localRequest = parse(requestData) else {
      send(
        status: NamaPlaybackHTTPStatus.badRequest,
        body: Data(),
        contentType: "text/plain",
        on: connection
      )
      return
    }
    guard localRequest.method == "GET" || localRequest.method == "HEAD" else {
      send(
        status: NamaPlaybackHTTPStatus.methodNotAllowed,
        body: Data(),
        contentType: "text/plain",
        on: connection
      )
      return
    }

    lock.lock()
    let bridgeResource = resources[localRequest.path]
    let bridgeStopped = stopped
    lock.unlock()
    guard !bridgeStopped, let bridgeResource else {
      send(
        status: NamaPlaybackHTTPStatus.notFound,
        body: Data(),
        contentType: "text/plain",
        on: connection
      )
      return
    }
    guard bridgeResource.expiresAt > Date() else {
      send(
        status: NamaPlaybackHTTPStatus.serviceUnavailable,
        body: Data(),
        contentType: "text/plain",
        on: connection
      )
      return
    }
    startHandler(for: localRequest, resource: bridgeResource, connection: connection)
  }

  private func startHandler(
    for request: NamaPlaybackBridgeLocalRequest,
    resource: NamaPlaybackBridgeResource,
    connection: NWConnection
  ) {
    let handler = NamaPlaybackBridgeRequest(
      connection: connection,
      method: request.method,
      requestHeaders: request.headers,
      resource: resource,
      register: { [weak self] childResource in
        guard let self else {
          throw CancellationError()
        }
        return try localURL(for: childResource)
      },
      completion: { [weak self] identifier in
        self?.removeHandler(identifier)
      }
    )
    let identifier = ObjectIdentifier(handler)
    lock.lock()
    acceptedConnections.removeValue(forKey: ObjectIdentifier(connection))
    guard !stopped, resource.expiresAt > Date() else {
      lock.unlock()
      handler.cancel()
      return
    }
    handlers[identifier] = handler
    lock.unlock()
    handler.start()
  }

  private func removeHandler(_ identifier: ObjectIdentifier) {
    lock.lock()
    handlers.removeValue(forKey: identifier)
    lock.unlock()
  }

  private func removeAcceptedConnection(_ connection: NWConnection) {
    lock.lock()
    acceptedConnections.removeValue(forKey: ObjectIdentifier(connection))
    lock.unlock()
  }

  private func parse(_ data: Data) -> NamaPlaybackBridgeLocalRequest? {
    guard let request = String(data: data, encoding: .utf8) else {
      return nil
    }
    let lines = request.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else {
      return nil
    }
    let requestParts = requestLine.split(separator: " ")
    guard
      let methodPart = requestParts.first,
      let pathPart = requestParts.dropFirst().first
    else {
      return nil
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
    return NamaPlaybackBridgeLocalRequest(method: method, path: path, headers: headers)
  }

  private func send(
    status: Int,
    body: Data,
    contentType: String,
    on connection: NWConnection
  ) {
    removeAcceptedConnection(connection)
    let head = [
      "HTTP/1.1 \(status) \(NamaPlaybackHTTPStatus.reason(for: status))",
      "Content-Type: \(contentType)",
      "Content-Length: \(body.count)",
      "Connection: close",
      "",
      "",
    ].joined(separator: "\r\n")
    var responseData = Data(head.utf8)
    responseData.append(body)
    connection.send(
      content: responseData,
      contentContext: .finalMessage,
      isComplete: true,
      completion: .contentProcessed { _ in connection.cancel() }
    )
  }
}
