import Foundation
import ImageIO

@testable import Nama

func homeArtworkItem(artwork: [HomeArtworkReference]) -> HomeMediaSummary {
  homeArtworkItem(identity: "movie-1", artwork: artwork)
}

func homeArtworkItem(
  identity: String,
  artwork: [HomeArtworkReference]
) -> HomeMediaSummary {
  HomeMediaSummary(
    identity: HomeMediaIdentity(identity),
    kind: .movie,
    title: "Movie title",
    releaseYear: nil,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: artwork,
    playability: .playable,
    defaultSource: nil
  )
}

func homeArtworkSnapshot(items: [HomeMediaSummary]) -> HomeSnapshot {
  HomeSnapshot(
    movies: HomeShelf(
      identity: HomeShelfIdentity("movies"),
      title: "Movies",
      kind: .movies,
      items: items
    ),
    shows: nil
  )
}

func homeArtworkReference(
  identity: String,
  role: HomeArtworkRole,
  textPresence: HomeArtworkTextPresence
) -> HomeArtworkReference {
  HomeArtworkReference(
    identity: HomeArtworkIdentity(identity),
    role: role,
    width: nil,
    height: nil,
    locale: nil,
    textPresence: textPresence
  )
}

func homeTextlessPosterItem(number: Int) -> HomeMediaSummary {
  let reference = homeArtworkReference(
    identity: "poster-\(number)",
    role: .poster,
    textPresence: .textless
  )
  return homeArtworkItem(identity: "movie-\(number)", artwork: [reference])
}

func artworkLocator(
  url: URL,
  headers: [HomeArtworkHeader] = [],
  allowedRedirectOrigins: [String] = ["https://artwork.example.test"],
  refreshAt: Date = ArtworkFixture.future,
  accessExpiresAt: Date? = ArtworkFixture.future
) -> HomeArtworkResolvedLocator {
  HomeArtworkResolvedLocator(
    url: url.absoluteString,
    headers: headers,
    allowedRedirectOrigins: allowedRedirectOrigins,
    refreshAt: refreshAt,
    accessExpiresAt: accessExpiresAt,
    width: nil,
    height: nil
  )
}

func makeArtworkLoader(
  resolver: any HomeArtworkResolving
) -> HomeArtworkLoader {
  HomeArtworkLoader(
    resolver: resolver,
    sessionConfiguration: artworkSessionConfiguration(),
    cacheCostLimit: ArtworkFixture.cacheCostLimit
  ) { ArtworkFixture.now }
}

func loadArtwork(
  _ loader: HomeArtworkLoader,
  authorization: HomeAuthorizationIdentity,
  size: HomeArtworkSizeBucket? = nil
) async -> HomeArtworkPresentation? {
  await loader.authorizationDidChange(to: authorization)
  return await loader.image(
    for: homeArtworkReference(identity: "poster", role: .poster, textPresence: .textless),
    size: size ?? artworkSize(),
    authorization: authorization
  )
}

nonisolated func artworkSize() -> HomeArtworkSizeBucket {
  .poster(
    displayWidth: ArtworkFixture.cardWidth,
    scale: ArtworkFixture.retinaScale
  )
}

nonisolated enum ArtworkFixture {
  static let cardWidth = 148.0
  static let retinaScale = 2.0
  static let threeXScale = 3.0
  static let expectedPixelWidth: UInt32 = 384
  static let expectedPixelHeight: UInt32 = 576
  static let nowSeconds: TimeInterval = 1_000
  static let futureSeconds: TimeInterval = 2_000
  static let now = Date(timeIntervalSince1970: nowSeconds)
  static let future = Date(timeIntervalSince1970: futureSeconds)
  static let cacheCostLimit = 1_000_000
  static let tinyEncodedByteLimit = 4
  static let redirectStatus = 302
  static let successStatus = 200
  static let imageData: Data = {
    guard
      let data = Data(
        base64Encoded:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1j8AAAAASUVORK5CYII="
      )
    else {
      preconditionFailure("Artwork image fixture is invalid")
    }
    return data
  }()
  static let presentation: HomeArtworkPresentation = {
    guard
      let source = CGImageSourceCreateWithData(imageData as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, .zero, nil)
    else {
      preconditionFailure("Artwork presentation fixture is invalid")
    }
    return HomeArtworkPresentation(image: image)
  }()
}

actor FixedArtworkResolver: HomeArtworkResolving {
  let locator: HomeArtworkResolvedLocator

  init(locator: HomeArtworkResolvedLocator) {
    self.locator = locator
  }

  func resolve(
    _: HomeArtworkReference,
    size _: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkResolvedLocator {
    locator
  }
}

actor RecordingArtworkResolver: HomeArtworkResolving {
  let locator: HomeArtworkResolvedLocator
  private(set) var requestedSizes: [HomeArtworkSizeBucket] = []

  init(locator: HomeArtworkResolvedLocator) {
    self.locator = locator
  }

  func resolve(
    _: HomeArtworkReference,
    size: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkResolvedLocator {
    requestedSizes.append(size)
    return locator
  }
}

actor ManualArtworkResolver: HomeArtworkResolving {
  private var continuations: [CheckedContinuation<HomeArtworkResolvedLocator, any Error>] = []

  var callCount: Int {
    continuations.count
  }

  func resolve(
    _: HomeArtworkReference,
    size _: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) async throws -> HomeArtworkResolvedLocator {
    try await withCheckedThrowingContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func complete(call index: Int, with locator: HomeArtworkResolvedLocator) {
    continuations[index].resume(returning: locator)
  }
}

actor ImmediateArtworkHomeLoader: HomeLoading {
  let snapshot: HomeSnapshot

  init(snapshot: HomeSnapshot) {
    self.snapshot = snapshot
  }

  func load(for _: HomeAuthorizationIdentity) -> HomeSnapshot {
    snapshot
  }
}

actor RecordingArtworkLoader: HomeArtworkLoading {
  private(set) var requestedIdentities: [HomeArtworkIdentity] = []

  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This adapter has no cache to invalidate.
  }

  func image(
    for reference: HomeArtworkReference,
    size _: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    requestedIdentities.append(reference.identity)
    return nil
  }
}

actor HoldingArtworkLoader: HomeArtworkLoading {
  private(set) var requestCount = Int.zero
  private(set) var cancellationCount = Int.zero

  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This adapter has no cache to invalidate.
  }

  func image(
    for _: HomeArtworkReference,
    size _: HomeArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) async -> HomeArtworkPresentation? {
    requestCount += 1
    let stream = AsyncStream<Void> { continuation in
      continuation.onTermination = { [weak self] _ in
        Task {
          await self?.recordCancellation()
        }
      }
    }
    var iterator = stream.makeAsyncIterator()
    _ = await iterator.next()
    return nil
  }

  private func recordCancellation() {
    cancellationCount += 1
  }
}

func artworkAuthorization(generation: UInt64) throws -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessTokenExpiresAt: ArtworkFixture.future,
    generation: generation
  )
}

func artworkSessionConfiguration() -> URLSessionConfiguration {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [ArtworkURLProtocol.self]
  return configuration
}

nonisolated final class ArtworkURLProtocol: URLProtocol, @unchecked Sendable {
  enum Outcome: Sendable {
    case redirect(URL)
    case response(Data)
    case responseAfter(Data, @Sendable () -> Void)
    case hold
  }

  private static let lock = NSLock()
  nonisolated(unsafe) private static var outcomes: [URL: Outcome] = [:]
  nonisolated(unsafe) private static var requests: [URLRequest] = []
  nonisolated(unsafe) private static var stopped = Int.zero

  static var recordedRequests: [URLRequest] {
    lock.withLock { requests }
  }

  static var stopCount: Int {
    lock.withLock { stopped }
  }

  static func configure(_ newOutcomes: [URL: Outcome]) {
    lock.withLock {
      outcomes = newOutcomes
      requests = []
      stopped = .zero
    }
  }

  static func reset() {
    configure([:])
  }

  // URLProtocol requires these overrides to remain class methods.
  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
  override class func canInit(with _: URLRequest) -> Bool {
    true
  }

  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    guard let url = request.url else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    let outcome = Self.lock.withLock { () -> Outcome? in
      Self.requests.append(request)
      return Self.outcomes[url]
    }
    switch outcome {
    case .redirect(let destination):
      sendRedirect(from: url, to: destination)

    case .response(let data):
      sendResponse(data, from: url)

    case .responseAfter(let data, let beforeResponse):
      beforeResponse()
      sendResponse(data, from: url)

    case .hold:
      break

    case nil:
      client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
    }
  }

  override func stopLoading() {
    Self.lock.withLock {
      Self.stopped += 1
    }
  }

  private func sendRedirect(from url: URL, to destination: URL) {
    guard
      let response = HTTPURLResponse(
        url: url,
        statusCode: ArtworkFixture.redirectStatus,
        httpVersion: "HTTP/1.1",
        headerFields: ["location": destination.absoluteString]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    var redirectedRequest = request
    redirectedRequest.url = destination
    client?.urlProtocol(
      self,
      wasRedirectedTo: redirectedRequest,
      redirectResponse: response
    )
    client?.urlProtocol(self, didLoad: Data())
    client?.urlProtocolDidFinishLoading(self)
  }

  private func sendResponse(_ data: Data, from url: URL) {
    guard
      let response = HTTPURLResponse(
        url: url,
        statusCode: ArtworkFixture.successStatus,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "image/png"]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: data)
    client?.urlProtocolDidFinishLoading(self)
  }
}
