import Foundation
import Testing

@testable import Nama

extension HomeArtworkLoaderTests {
  @Test("caches decoded artwork by reference and requested size bucket")
  func cachesByReferenceAndSize() async throws {
    let url = try #require(URL(string: "https://artwork.example.test/poster"))
    ArtworkURLProtocol.configure([url: .response(ArtworkFixture.imageData)])
    defer { ArtworkURLProtocol.reset() }
    let resolver = RecordingArtworkResolver(locator: artworkLocator(url: url))
    let loader = makeArtworkLoader(resolver: resolver)
    let authorization = try artworkAuthorization(generation: 6)
    let standardSize = artworkSize()
    let largerSize = ArtworkSizeBucket.poster(
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
