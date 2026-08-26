import Foundation
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

  @Test("rejects authorization-bearing locators without an access expiry")
  func rejectsAuthorizationWithoutExpiry() async throws {
    ArtworkURLProtocol.configure([:])
    defer { ArtworkURLProtocol.reset() }
    let headerURL = try #require(URL(string: "https://artwork.example.test/poster"))
    let queryURL = try #require(
      URL(string: "https://artwork.example.test/poster?token=short-lived-secret")
    )
    let locators = [
      artworkLocator(
        url: headerURL,
        headers: [HomeArtworkHeader(name: "X-Artwork-Token", value: "short-lived-secret")],
        accessExpiresAt: nil
      ),
      artworkLocator(url: queryURL, accessExpiresAt: nil),
    ]

    for (index, locator) in locators.enumerated() {
      let loader = makeArtworkLoader(resolver: FixedArtworkResolver(locator: locator))
      let image = await loadArtwork(
        loader,
        authorization: try artworkAuthorization(generation: UInt64(index + 20))
      )
      #expect(image == nil)
    }
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

  @Test("caches decoded artwork by reference and requested size bucket")
  func cachesByReferenceAndSize() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = RecordingArtworkResolver(locator: artworkLocator(url: url))
    let loader = makeArtworkLoader(resolver: resolver)
    let authorization = try artworkAuthorization(generation: 6)
    let standardSize = artworkSize()
    let largerSize = HomeArtworkSizeBucket.poster(
      displayWidth: ArtworkFixture.cardWidth,
      scale: ArtworkFixture.threeXScale
    )

    #expect(await loadArtwork(loader, authorization: authorization, size: standardSize) != nil)
    #expect(await loadArtwork(loader, authorization: authorization, size: standardSize) != nil)
    #expect(await loadArtwork(loader, authorization: authorization, size: largerSize) != nil)

    #expect(await resolver.requestedSizes == [standardSize, largerSize])
    #expect(ArtworkURLProtocol.recordedRequests.count == 2)
  }

  @Test("an authorization identity change purges decoded artwork")
  func invalidatesSessionCache() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = RecordingArtworkResolver(locator: artworkLocator(url: url))
    let loader = makeArtworkLoader(resolver: resolver)
    let firstAuthorization = try artworkAuthorization(generation: 7)
    let replacementAuthorization = try artworkAuthorization(generation: 8)

    #expect(await loadArtwork(loader, authorization: firstAuthorization) != nil)
    #expect(await loadArtwork(loader, authorization: firstAuthorization) != nil)
    await loader.authorizationDidChange(to: replacementAuthorization)
    #expect(await loadArtwork(loader, authorization: replacementAuthorization) != nil)

    #expect(await resolver.requestedSizes.count == 2)
    #expect(ArtworkURLProtocol.recordedRequests.count == 2)
  }

  @Test("a stale request cannot reinstall a prior authorization identity")
  func rejectsStaleAuthorizationAtEntry() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = RecordingArtworkResolver(locator: artworkLocator(url: url))
    let loader = makeArtworkLoader(resolver: resolver)
    let staleAuthorization = try artworkAuthorization(generation: 9)
    let currentAuthorization = try artworkAuthorization(generation: 10)
    await loader.authorizationDidChange(to: currentAuthorization)

    let stalePresentation = await loader.image(
      for: homeArtworkReference(identity: "poster", role: .poster, textPresence: .textless),
      size: artworkSize(),
      authorization: staleAuthorization
    )

    #expect(stalePresentation == nil)
    #expect(await resolver.requestedSizes.isEmpty)
    #expect(await loadArtwork(loader, authorization: currentAuthorization) != nil)
  }

  @Test("an old authorization completion cannot start an artwork fetch")
  func rejectsStaleResolutionCompletion() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = ManualArtworkResolver()
    let loader = makeArtworkLoader(resolver: resolver)
    let firstAuthorization = try artworkAuthorization(generation: 9)
    let replacementAuthorization = try artworkAuthorization(generation: 10)

    let task = Task {
      await loadArtwork(loader, authorization: firstAuthorization)
    }
    await eventually { await resolver.callCount == 1 }
    await loader.authorizationDidChange(to: replacementAuthorization)
    await resolver.complete(call: 0, with: artworkLocator(url: url))

    #expect(await task.value == nil)
    #expect(ArtworkURLProtocol.recordedRequests.isEmpty)
  }

  @Test("memory pressure purges decoded artwork")
  func purgesCacheOnMemoryPressure() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = RecordingArtworkResolver(locator: artworkLocator(url: url))
    let loader = makeArtworkLoader(resolver: resolver)
    let authorization = try artworkAuthorization(generation: 11)

    #expect(await loadArtwork(loader, authorization: authorization) != nil)
    #expect(await loadArtwork(loader, authorization: authorization) != nil)
    await loader.handleMemoryPressure()
    #expect(await loadArtwork(loader, authorization: authorization) != nil)

    #expect(await resolver.requestedSizes.count == 2)
    #expect(ArtworkURLProtocol.recordedRequests.count == 2)
  }
}
