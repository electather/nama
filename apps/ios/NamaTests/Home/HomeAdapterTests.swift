import Foundation
import Testing

@testable import Nama

private enum HomeAdapterExpected {
  static let releaseYear: UInt32 = 2_026
  static let runtimeSeconds: Int64 = 7_200
  static let runtime: Duration = .seconds(runtimeSeconds)
  static let tokenExpiry: TimeInterval = 4_600
}

@Suite("Home LibraryService adapter", .serialized)
@MainActor
struct HomeAdapterTests {
  @Test("GetHome maps complete app-owned media and preserves item order")
  func responseMappingAndMetadata() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: HomeTransportFixture.homeResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "tvos")

    let snapshot = try await client.load(
      for: homeAuthorization(record: record, generation: 11)
    )

    try assertHomeSnapshot(snapshot)
    try assertHomeRequest()
  }

  @Test("CATALOG_NOT_READY exposes bounded retry guidance")
  func catalogNotReadyMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: HomeTransportFixture.catalogNotReadyResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.catalogNotReady(retryAfterSeconds: 9)) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 12)
      )
    }
  }

  @Test("an oversized Home response is incompatible")
  func oversizedResponseIsIncompatible() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: HomeTransportFixture.oversizedHomeResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.incompatible) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 13)
      )
    }
  }

  @Test(
    "invalid Unicode length or artwork locale is incompatible",
    arguments: [
      HomeTransportFixture.overlongCombiningTitleResponse,
      HomeTransportFixture.malformedArtworkLocaleResponse,
    ]
  )
  func invalidStructuralValuesAreIncompatible(body: String) async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: body
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.incompatible) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 14)
      )
    }
  }

  @Test("Connect code takes precedence over an inapplicable compatibility reason")
  func connectCodePrecedesReason() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: HomeTransportFixture.unsupportedReasonAtUnavailableResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.namaUnavailable(requestID: nil)) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 14)
      )
    }
  }

  @Test("a canonical request ID is exposed for support")
  func canonicalRequestIDIsExposed() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: HomeTransportFixture.unavailableResponse(
        requestInfoValue: HomeTransportFixture.validRequestInfoValue
      )
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(
      throws: HomeLoadingFailure.namaUnavailable(
        requestID: "2f1c5f44-6a9b-4d2e-8c70-62df607c2efa"
      )
    ) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 15)
      )
    }
  }

  @Test(
    "unsafe request IDs are omitted",
    arguments: [
      HomeTransportFixture.unsafeRequestInfoValue,
      HomeTransportFixture.overlongRequestInfoValue,
    ]
  )
  func unsafeRequestIDIsOmitted(requestInfoValue: String) async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: HomeTransportFixture.unavailableResponse(requestInfoValue: requestInfoValue)
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.namaUnavailable(requestID: nil)) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 16)
      )
    }
  }

  @Test("a changed authorization record cannot send the previous access token")
  func changedAuthorizationRejectsOldRecord() async throws {
    HomeConnectStubURLProtocol.reset()
    let record = try homeTokenRecord()
    let client = homeClient(record: record, platform: "ios")

    await #expect(throws: HomeLoadingFailure.authorizationUnavailable) {
      try await client.load(
        for: homeAuthorization(record: record, generation: 13, expiryOffset: 1)
      )
    }
    #expect(HomeConnectStubURLProtocol.recordedRequests.isEmpty)
  }
}

@MainActor
private func homeClient(
  record: EndpointBoundOAuthTokenRecord,
  platform: String
) -> NamaLibraryClient {
  NamaLibraryClient(
    clientVersion: "1.2.3",
    tokenStore: InMemoryOAuthTokenStore(snapshot: .record(record)),
    sessionConfiguration: homeStubConfiguration(),
    platform: platform
  )
}

nonisolated private func homeAuthorization(
  record: EndpointBoundOAuthTokenRecord,
  generation: UInt64,
  expiryOffset: TimeInterval = 0
) -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: record.endpoint,
    accessTokenExpiresAt: record.accessTokenExpiresAt.addingTimeInterval(expiryOffset),
    generation: generation
  )
}

@MainActor
private func assertHomeSnapshot(_ snapshot: HomeSnapshot) throws {
  #expect(snapshot.shelves.map(\.kind) == [.movies])
  #expect(snapshot.movies?.items.map(\.title) == ["Second from server", "First from server"])
  #expect(snapshot.shows == nil)
  let item = try #require(snapshot.movies?.items.first)
  #expect(item.identity == HomeMediaIdentity("movie-2"))
  #expect(item.releaseYear == HomeAdapterExpected.releaseYear)
  #expect(item.runtime == HomeAdapterExpected.runtime)
  #expect(item.artwork.first?.identity == HomeArtworkIdentity("artwork-2"))
  #expect(item.artwork.first?.role == .poster)
  #expect(item.artwork.first?.textPresence == .textless)
  #expect(item.playability == .playable)
  #expect(item.defaultSource?.identity == HomeSourceIdentity("source-2"))
  #expect(item.defaultSource?.availability == .available)
  #expect(item.defaultSource?.videoQuality?.dynamicRange == .hdr10)
  #expect(item.defaultSource?.audioQuality?.spatialFormat == .dolbyAtmos)
}

@MainActor
private func assertHomeRequest() throws {
  let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
  #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token-secret")
  #expect(request.value(forHTTPHeaderField: "nama-client-name") == "nama-ios")
  #expect(request.value(forHTTPHeaderField: "nama-client-platform") == "tvos")
  #expect(request.value(forHTTPHeaderField: "nama-client-version") == "1.2.3")
  #expect(request.url?.path == "/nama.api.v1.LibraryService/GetHome")
}

private func homeTokenRecord() throws -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    accessTokenExpiresAt: Date(timeIntervalSince1970: HomeAdapterExpected.tokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}
