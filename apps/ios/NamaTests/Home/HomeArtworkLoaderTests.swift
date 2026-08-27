import Foundation
import Synchronization
import Testing

@testable import Nama

@Suite("Home artwork loader", .serialized)
struct HomeArtworkLoaderTests {
  @Test("strips scoped headers from an allowed cross-origin artwork redirect")
  func stripsHeadersAcrossRedirect() async throws {
    let initialURL = try #require(URL(string: "https://artwork.example.test/poster"))
    let redirectedURL = try #require(URL(string: "https://cdn.example.test/poster"))
    ArtworkURLProtocol.configure([
      initialURL: .redirect(redirectedURL),
      redirectedURL: .response(ArtworkFixture.imageData),
    ])
    defer { ArtworkURLProtocol.reset() }
    let resolver = FixedArtworkResolver(
      locator: HomeArtworkResolvedLocator(
        url: initialURL.absoluteString,
        headers: [HomeArtworkHeader(name: "X-Artwork-Token", value: "short-lived-secret")],
        allowedRedirectOrigins: ["https://artwork.example.test", "https://cdn.example.test"],
        refreshAt: ArtworkFixture.future,
        accessExpiresAt: ArtworkFixture.future,
        width: nil,
        height: nil
      )
    )
    let loader = makeArtworkLoader(resolver: resolver)
    let authorization = try artworkAuthorization(generation: 1)

    await loader.authorizationDidChange(to: authorization)
    let image = await loadArtwork(loader, authorization: authorization)

    let requests = ArtworkURLProtocol.recordedRequests
    #expect(image != nil)
    #expect(requests.count == 2)
    #expect(requests.first?.value(forHTTPHeaderField: "X-Artwork-Token") == "short-lived-secret")
    #expect(requests.last?.value(forHTTPHeaderField: "X-Artwork-Token") == nil)
  }

  @Test("rejects a redirect outside the locator allowlist")
  func rejectsDisallowedRedirect() throws {
    let initialURL = try #require(URL(string: "https://artwork.example.test/poster"))
    let disallowedURL = try #require(URL(string: "https://attacker.example.test/poster"))
    let policy = try #require(
      HomeArtworkRedirectPolicy(
        initialURL: initialURL,
        headers: [HomeArtworkHeader(name: "X-Artwork-Token", value: "short-lived-secret")],
        allowedRedirectOrigins: ["https://artwork.example.test"]
      )
    )
    var hasLeftInitialOrigin = false
    var request = URLRequest(url: disallowedURL)
    request.setValue("short-lived-secret", forHTTPHeaderField: "X-Artwork-Token")

    #expect(
      policy.redirectedRequest(
        request,
        hasLeftInitialOrigin: &hasLeftInitialOrigin
      ) == nil
    )
  }

  @Test("does not start an artwork fetch after either locator deadline")
  func rejectsExpiredLocator() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let expiredLocators = [
      artworkLocator(url: url, refreshAt: ArtworkFixture.now),
      artworkLocator(
        url: url,
        refreshAt: ArtworkFixture.future,
        accessExpiresAt: ArtworkFixture.now
      ),
    ]

    for (index, locator) in expiredLocators.enumerated() {
      let loader = makeArtworkLoader(resolver: FixedArtworkResolver(locator: locator))
      let image = await loadArtwork(
        loader,
        authorization: try artworkAuthorization(generation: UInt64(index + 2))
      )
      #expect(image == nil)
    }
    #expect(ArtworkURLProtocol.recordedRequests.isEmpty)
  }

  @Test("keeps artwork fetched before its refresh deadline")
  func keepsFetchCompletingAfterRefreshDeadline() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    let clock = Mutex(ArtworkFixture.now)
    let response: ArtworkURLProtocol.Outcome = .responseAfter(ArtworkFixture.imageData) {
      clock.withLock { instant in
        instant = ArtworkFixture.future
      }
    }
    ArtworkURLProtocol.configure([url: response])
    defer { ArtworkURLProtocol.reset() }
    let refreshAt = ArtworkFixture.now.addingTimeInterval(1)
    let loader = HomeArtworkLoader(
      resolver: FixedArtworkResolver(
        locator: artworkLocator(
          url: url,
          refreshAt: refreshAt,
          accessExpiresAt: ArtworkFixture.future
        )
      ),
      sessionConfiguration: artworkSessionConfiguration(),
      cacheCostLimit: ArtworkFixture.cacheCostLimit
    ) {
      clock.withLock { $0 }
    }

    let image = await loadArtwork(
      loader,
      authorization: try artworkAuthorization(generation: 22)
    )

    #expect(image != nil)
    #expect(ArtworkURLProtocol.recordedRequests.count == 1)
  }

  @Test("accepts credential-free public artwork locators with cache queries")
  func acceptsPublicQueryWithoutExpiry() async throws {
    let url = try #require(
      URL(string: "https://artwork.example.test/poster?tag=cache-tag&maxWidth=384")
    )
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let loader = makeArtworkLoader(
      resolver: FixedArtworkResolver(
        locator: artworkLocator(url: url, accessExpiresAt: nil)
      )
    )

    let image = await loadArtwork(
      loader,
      authorization: try artworkAuthorization(generation: 20)
    )

    #expect(image != nil)
    #expect(ArtworkURLProtocol.recordedRequests.count == 1)
  }

  @Test("rejects header-bearing locators without an access expiry")
  func rejectsAuthorizationHeaderWithoutExpiry() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let loader = makeArtworkLoader(
      resolver: FixedArtworkResolver(
        locator: artworkLocator(
          url: url,
          headers: [HomeArtworkHeader(name: "X-Artwork-Token", value: "short-lived-secret")],
          accessExpiresAt: nil
        )
      )
    )

    let image = await loadArtwork(
      loader,
      authorization: try artworkAuthorization(generation: 21)
    )

    #expect(image == nil)
    #expect(ArtworkURLProtocol.recordedRequests.isEmpty)
  }

  @Test("cancels an in-flight artwork fetch")
  func cancelsFetch() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .hold])
    defer { ArtworkURLProtocol.reset() }
    let loader = makeArtworkLoader(
      resolver: FixedArtworkResolver(locator: artworkLocator(url: url))
    )
    let authorization = try artworkAuthorization(generation: 4)

    let task = Task {
      await loadArtwork(loader, authorization: authorization)
    }
    await eventually { ArtworkURLProtocol.recordedRequests.count == 1 }
    task.cancel()

    #expect(await task.value == nil)
    await eventually { ArtworkURLProtocol.stopCount == 1 }
  }

  @Test("undecodable artwork returns no presentation data")
  func rejectsUndecodableArtwork() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(Data("not an image".utf8))])
    defer { ArtworkURLProtocol.reset() }
    let loader = makeArtworkLoader(
      resolver: FixedArtworkResolver(locator: artworkLocator(url: url))
    )

    let image = await loadArtwork(
      loader,
      authorization: try artworkAuthorization(generation: 5)
    )

    #expect(image == nil)
  }

  @Test("stops reading artwork when the encoded body exceeds its limit")
  func rejectsOversizedEncodedArtwork() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let locator = try #require(
      ValidatedArtworkLocator(artworkLocator(url: url), now: ArtworkFixture.now)
    )
    let client = HomeArtworkHTTPClient(
      configuration: artworkSessionConfiguration(),
      maximumEncodedBytes: ArtworkFixture.tinyEncodedByteLimit
    )

    await #expect(throws: URLError.self) {
      try await client.fetch(locator)
    }
  }
}
