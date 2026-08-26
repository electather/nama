import Foundation
import Network

nonisolated final class NamaPlaybackBridgeRequest: NSObject, @unchecked Sendable {
  static let maximumPlaylistBytes = 4_194_304
  static let hexadecimalRadix = 16
  static let forwardedRequestHeaders = ["range", "if-range"]
  static let forwardedResponseHeaders = [
    "accept-ranges", "cache-control", "content-range", "etag", "last-modified",
  ]

  let connection: NWConnection
  let method: String
  let requestHeaders: [String: String]
  let resource: NamaPlaybackBridgeResource
  let register: @Sendable (NamaPlaybackBridgeResource) throws -> URL
  let completion: @Sendable (ObjectIdentifier) -> Void
  let operationQueue: OperationQueue
  let finishLock = NSLock()
  var finished = false
  var session: URLSession?
  var task: URLSessionDataTask?
  var upstreamResponse: HTTPURLResponse?
  var playlistData = Data()
  var buffersPlaylist = false
  var streamsChunked = false
  var rejectedRedirect = false
  var sentResponseHead = false

  init(
    connection: NWConnection,
    method: String,
    requestHeaders: [String: String],
    resource: NamaPlaybackBridgeResource,
    register: @escaping @Sendable (NamaPlaybackBridgeResource) throws -> URL,
    completion: @escaping @Sendable (ObjectIdentifier) -> Void
  ) {
    self.connection = connection
    self.method = method
    self.requestHeaders = requestHeaders
    self.resource = resource
    self.register = register
    self.completion = completion
    operationQueue = OperationQueue()
    operationQueue.name = "com.electather.nama.playback-http-bridge.request"
    operationQueue.maxConcurrentOperationCount = 1
  }

  func start() {
    var upstreamRequest = URLRequest(url: resource.url)
    upstreamRequest.httpMethod = method
    applyStoredHeaders(to: &upstreamRequest)
    upstreamRequest.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    if !Self.isLikelyPlaylist(resource) {
      for name in Self.forwardedRequestHeaders {
        if let value = requestHeaders[name] {
          upstreamRequest.setValue(value, forHTTPHeaderField: name)
        }
      }
    }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let upstreamSession = URLSession(
      configuration: configuration,
      delegate: self,
      delegateQueue: operationQueue
    )
    let upstreamTask = upstreamSession.dataTask(with: upstreamRequest)
    session = upstreamSession
    task = upstreamTask
    upstreamTask.resume()
  }

  func cancel() {
    operationQueue.addOperation { [weak self] in
      guard let self else {
        return
      }
      task?.cancel()
      session?.invalidateAndCancel()
      connection.cancel()
      finish()
    }
  }
}
