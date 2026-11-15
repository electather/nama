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

  @Test("saving local HTTP persists its exact canonical acknowledgement")
  func persistsCanonicalLocalHTTPAcknowledgement() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let endpoint = try NamaEndpoint("HTTP://NAMA.LOCAL:80/reverse-proxy")
    let snapshot = await store.snapshot()

    #expect(await store.save(endpoint, ifUnchangedSince: snapshot))

    let domain = try #require(defaults.persistentDomain(forName: suiteName))
    #expect(domain["verifiedNamaEndpoint"] as? String == "http://nama.local/reverse-proxy/")
    #expect(
      domain["acknowledgedLocalHTTPNamaEndpoint"] as? String
        == "http://nama.local/reverse-proxy/"
    )
  }

  @Test("saving HTTPS removes a stale local HTTP acknowledgement")
  func savingHTTPSRemovesLocalHTTPAcknowledgement() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let localHTTP = try NamaEndpoint("http://nama.local")
    #expect(
      await store.save(
        localHTTP,
        ifUnchangedSince: store.snapshot()
      )
    )
    let https = try NamaEndpoint("https://nama.example.com")

    #expect(
      await store.save(
        https,
        ifUnchangedSince: store.snapshot()
      )
    )

    let domain = try #require(defaults.persistentDomain(forName: suiteName))
    #expect(domain["verifiedNamaEndpoint"] as? String == https.absoluteString)
    #expect(domain["acknowledgedLocalHTTPNamaEndpoint"] == nil)
  }

  @Test(
    "retains a legacy forbidden HTTP endpoint for explicit recovery",
    arguments: [
      "http://nama.example.com/reverse-proxy/",
      "http://.local",
    ]
  )
  func retainsForbiddenHTTP(savedAddress: String) async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    defaults.set(savedAddress, forKey: "verifiedNamaEndpoint")
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)

    let snapshot = await store.snapshot()

    #expect(snapshot.endpoint == .requiresHTTPS(HTTPSRequiredEndpoint(savedAddress)))
    #expect(defaults.string(forKey: "verifiedNamaEndpoint") == savedAddress)
  }

  @Test("acknowledgement without a saved endpoint cannot authorize HTTP")
  func rejectsAcknowledgementWithoutEndpoint() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let endpoint = try NamaEndpoint("http://nama.local")
    defaults.set(
      endpoint.absoluteString,
      forKey: "acknowledgedLocalHTTPNamaEndpoint"
    )
    let snapshot = await UserDefaultsVerifiedEndpointStore(
      suiteName: suiteName
    ).snapshot()

    #expect(snapshot.endpoint == nil)
    #expect(!snapshot.acknowledgesLocalHTTP(endpoint))
  }

  @Test("explicit clearing removes the saved endpoint and acknowledgement")
  func clearsEndpoint() async throws {
    let suiteName = "NamaTests.VerifiedEndpointStore.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = UserDefaultsVerifiedEndpointStore(suiteName: suiteName)
    let snapshot = await store.snapshot()
    #expect(
      await store.save(
        try NamaEndpoint("http://nama.local"),
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
    let endpoint = try NamaEndpoint("http://nama.local")

    await store.clear()

    #expect(await !store.save(endpoint, ifUnchangedSince: snapshot))
    #expect(await store.snapshot().endpoint == nil)
    #expect(defaults.persistentDomain(forName: suiteName)?.isEmpty != false)
  }
}
