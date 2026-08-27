import Foundation
import Testing

@testable import Nama

private enum LibraryAdapterFixture {
  static let tokenExpiry: TimeInterval = 4_600
  static let excessiveItemCount = 51
  static let excessiveTokenByteCount = 4_097
  static let pageResponse = #"""
    {
      "items": [
        {
          "id": "movie-display-b",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "Second from server",
          "releaseYear": 2026,
          "playability": "PLAYABILITY_PLAYABLE"
        },
        {
          "id": "movie-display-a",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "First from server",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        }
      ],
      "nextPageToken": "opaque-page-two"
    }
    """#
  static let invalidPageTokenResponse = #"""
    {
      "code": "invalid_argument",
      "message": "page token is invalid",
      "details": [
        {
          "type": "google.rpc.ErrorInfo",
          "value": "ChJQQUdFX1RPS0VOX0lOVkFMSUQSC25hbWEuYXBpLnYx"
        }
      ]
    }
    """#
  static let oversizedPageResponse: String = {
    let item = #"""
      {
        "id": "movie",
        "kind": "MEDIA_KIND_MOVIE",
        "title": "Movie",
        "playability": "PLAYABILITY_PLAYABLE"
      }
      """#
    let items = Array(repeating: item, count: excessiveItemCount).joined(separator: ",")
    return """
      {
        "items": [\(items)]
      }
      """
  }()
  static let oversizedTokenResponse: String = {
    let token = String(repeating: "t", count: excessiveTokenByteCount)
    return """
      {
        "items": [],
        "nextPageToken": "\(token)"
      }
      """
  }()
}

@Suite("Library browse adapter", .serialized)
@MainActor
struct LibraryAdapterTests {
  @Test("ListLibrary sends bounded filters and preserves server order")
  func requestAndResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: LibraryAdapterFixture.pageResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try libraryTokenRecord()
    let client = libraryClient(record: record, platform: "macos")

    let page = try await client.loadPage(
      query: LibraryQuery(kind: .movies, sort: .releaseDate),
      pageToken: "opaque-page-one",
      authorization: libraryAuthorization(record: record)
    )

    #expect(
      page.items.map(\.identity) == [
        MediaIdentity("movie-display-b"), MediaIdentity("movie-display-a"),
      ])
    #expect(page.items.map(\.title) == ["Second from server", "First from server"])
    #expect(page.nextPageToken == "opaque-page-two")

    let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
    #expect(request.url?.path == "/nama.api.v1.LibraryService/ListLibrary")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token-secret")
    #expect(request.value(forHTTPHeaderField: "nama-client-platform") == "macos")
    let body = try #require(HomeConnectStubURLProtocol.recordedRequestBodies.first)
    let requestJSON = try #require(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )
    let filter = try #require(requestJSON["filter"] as? [String: Any])
    #expect(filter["kinds"] as? [String] == ["MEDIA_KIND_MOVIE"])
    #expect(filter["watchFilter"] as? String == "WATCH_FILTER_ANY")
    #expect(requestJSON["sort"] as? String == "LIBRARY_SORT_RELEASE_DATE_DESC")
    #expect(requestJSON["pageSize"] as? Int == 50)
    #expect(requestJSON["pageToken"] as? String == "opaque-page-one")
  }

  @Test("PAGE_TOKEN_INVALID remains a distinct recoverable browse failure")
  func invalidPageTokenMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: LibraryAdapterFixture.invalidPageTokenResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try libraryTokenRecord()
    let client = libraryClient(record: record, platform: "ios")

    await #expect(throws: LibraryLoadingFailure.pageTokenInvalid) {
      try await client.loadPage(
        query: .initial,
        pageToken: "expired",
        authorization: libraryAuthorization(record: record)
      )
    }
  }

  @Test("out-of-contract Library response bounds are incompatible")
  func responseBounds() async throws {
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try libraryTokenRecord()
    let client = libraryClient(record: record, platform: "ios")
    let responses = [
      LibraryAdapterFixture.oversizedPageResponse,
      LibraryAdapterFixture.oversizedTokenResponse,
    ]

    for body in responses {
      HomeConnectStubURLProtocol.configure(
        status: HomeTransportFixture.successfulHTTPStatus,
        body: body
      )
      await #expect(throws: LibraryLoadingFailure.incompatible) {
        try await client.loadPage(
          query: .initial,
          pageToken: nil,
          authorization: libraryAuthorization(record: record)
        )
      }
    }
  }

  @Test("a changed authorization cannot send the stored access token")
  func changedAuthorizationRejectsRecord() async throws {
    HomeConnectStubURLProtocol.reset()
    let record = try libraryTokenRecord()
    let client = libraryClient(record: record, platform: "ios")
    let staleAuthorization = HomeAuthorizationIdentity(
      endpoint: record.endpoint,
      accessTokenExpiresAt: record.accessTokenExpiresAt.addingTimeInterval(1),
      generation: 2
    )

    await #expect(throws: LibraryLoadingFailure.authorizationUnavailable) {
      try await client.loadPage(
        query: .initial,
        pageToken: nil,
        authorization: staleAuthorization
      )
    }
    #expect(HomeConnectStubURLProtocol.recordedRequests.isEmpty)
  }
}

@MainActor
private func libraryClient(
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

private func libraryTokenRecord() throws -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    accessTokenExpiresAt: Date(timeIntervalSince1970: LibraryAdapterFixture.tokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}

nonisolated private func libraryAuthorization(
  record: EndpointBoundOAuthTokenRecord
) -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: record.endpoint,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    generation: 1
  )
}
