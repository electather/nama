import Foundation
import Testing

@testable import Nama

@Suite("Verified endpoint preferences")
struct VerifiedEndpointStoreTests {
  @Test("persists only one normalized endpoint field")
  func persistsOnlyNormalizedEndpoint() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let endpoint = try NamaEndpoint("HTTPS://Nama.Example.com:443/reverse-proxy")
    let snapshot = await store.snapshot()

    #expect(await store.save(endpoint, ifUnchangedSince: snapshot))

    let domain = try #require(defaults.persistentDomain(forName: suiteName))
    #expect(domain.count == 1)
    #expect(domain["verifiedNamaEndpoint"] as? String == "https://nama.example.com/reverse-proxy/")
    #expect(await store.snapshot().endpoint == .eligible(endpoint))
  }

  @Test("retains a legacy forbidden HTTP endpoint for explicit recovery")
  func retainsForbiddenHTTP() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let savedAddress = "http://nama.example.com/reverse-proxy/"
    defaults.set(savedAddress, forKey: "verifiedNamaEndpoint")
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)

    let snapshot = await store.snapshot()

    #expect(snapshot.endpoint == .requiresHTTPS(savedAddress))
    #expect(defaults.string(forKey: "verifiedNamaEndpoint") == savedAddress)
  }

  @Test("explicit clearing removes the saved endpoint")
  func clearsEndpoint() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let snapshot = await store.snapshot()
    #expect(
      await store.save(
        try NamaEndpoint("https://nama.example.com"),
        ifUnchangedSince: snapshot
      )
    )

    await store.clear()

    #expect(await store.snapshot().endpoint == nil)
    #expect(defaults.persistentDomain(forName: suiteName)?.isEmpty != false)
  }

  @Test("clearing invalidates saves started by another window")
  func clearingInvalidatesEarlierSnapshot() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let snapshot = await store.snapshot()
    let endpoint = try NamaEndpoint("https://nama.example.com")

    await store.clear()

    #expect(await !store.save(endpoint, ifUnchangedSince: snapshot))
    #expect(await store.snapshot().endpoint == nil)
  }
}
