import Foundation

nonisolated extension NamaPlaybackBridgeRequest: URLSessionDataDelegate, URLSessionTaskDelegate {
  func urlSession(
    _: URLSession,
    task _: URLSessionTask,
    willPerformHTTPRedirection _: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: (URLRequest?) -> Void
  ) {
    guard let destination = request.url, resource.allows(destination) else {
      rejectedRedirect = true
      completionHandler(nil)
      return
    }
    var redirectedRequest = request
    applyStoredHeaders(to: &redirectedRequest)
    redirectedRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if !Self.isLikelyPlaylist(resource) {
      for name in Self.forwardedRequestHeaders {
        if let value = requestHeaders[name] {
          redirectedRequest.setValue(value, forHTTPHeaderField: name)
        }
      }
    }
    completionHandler(redirectedRequest)
  }

  func urlSession(
    _: URLSession,
    dataTask _: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: (URLSession.ResponseDisposition) -> Void
  ) {
    guard let httpResponse = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      sendFailure(status: NamaPlaybackHTTPStatus.badGateway)
      return
    }
    upstreamResponse = httpResponse
    if rejectedRedirect || NamaPlaybackHTTPStatus.redirectRange.contains(httpResponse.statusCode) {
      completionHandler(.cancel)
      sendFailure(status: NamaPlaybackHTTPStatus.forbidden)
      return
    }

    buffersPlaylist =
      method != "HEAD"
      && Self.isPlaylist(resource: resource, response: httpResponse)
    if buffersPlaylist {
      completionHandler(.allow)
      return
    }

    sentResponseHead = true
    let expectedLength = httpResponse.expectedContentLength
    streamsChunked = expectedLength < 0 && method != "HEAD"
    sendPart(responseHead(for: httpResponse, contentLength: expectedLength))
    completionHandler(.allow)
  }

  func urlSession(
    _: URLSession,
    dataTask: URLSessionDataTask,
    didReceive data: Data
  ) {
    if buffersPlaylist {
      guard playlistData.count + data.count <= Self.maximumPlaylistBytes else {
        dataTask.cancel()
        sendFailure(status: NamaPlaybackHTTPStatus.badGateway)
        return
      }
      playlistData.append(data)
      return
    }
    guard method != "HEAD" else {
      return
    }
    sendPart(streamsChunked ? Self.chunk(data) : data, suspending: dataTask)
  }

  func urlSession(
    _ session: URLSession,
    task _: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    defer {
      session.finishTasksAndInvalidate()
      finish()
    }
    guard !isFinished else {
      return
    }
    if error != nil {
      if sentResponseHead {
        connection.cancel()
      } else {
        sendFailure(status: NamaPlaybackHTTPStatus.badGateway)
      }
      return
    }
    if buffersPlaylist {
      completePlaylistResponse()
      return
    }
    if streamsChunked {
      sendComplete(Data("0\r\n\r\n".utf8))
    } else {
      sendComplete(nil)
    }
  }

  private func completePlaylistResponse() {
    guard let upstreamResponse else {
      sendFailure(status: NamaPlaybackHTTPStatus.badGateway)
      return
    }
    do {
      let rewritten = try rewritePlaylist(
        playlistData,
        relativeTo: upstreamResponse.url ?? resource.url
      )
      sendComplete(
        responseHead(for: upstreamResponse, contentLength: Int64(rewritten.count)) + rewritten
      )
    } catch {
      sendFailure(status: NamaPlaybackHTTPStatus.badGateway)
    }
  }
}
