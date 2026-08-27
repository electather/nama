import Foundation
import Testing

@testable import Nama

private enum MediaChildrenAdapterFixture {
  static let showChildrenResponse = #"""
    {
      "items": [
        {
          "id": "season-display-b",
          "kind": "MEDIA_KIND_SEASON",
          "title": "Season Two",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        {
          "id": "season-display-a",
          "kind": "MEDIA_KIND_SEASON",
          "title": "Season One",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        }
      ],
      "nextPageToken": "opaque-page-two"
    }
    """#
  static let seasonChildrenResponse = #"""
    {
      "items": [
        {
          "id": "episode-opaque-7",
          "kind": "MEDIA_KIND_EPISODE",
          "title": "The Seventh Episode",
          "runtime": "1800s",
          "episodePosition": {
            "seasonNumber": 2,
            "episodeNumber": 7
          },
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        {
          "id": "episode-opaque-8",
          "kind": "MEDIA_KIND_EPISODE",
          "title": "The Eighth Episode",
          "episodePosition": {
            "seasonNumber": 2,
            "episodeNumber": 8
          },
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        }
      ]
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
}

@Suite("Canonical child-page adapter", .serialized)
@MainActor
struct MediaChildrenAdapterTests {
  @Test("ListChildren preserves canonical Season display order and opaque continuation")
  func showChildrenPreserveDisplayOrder() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaChildrenAdapterFixture.showChildrenResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("opaque-show-parent"),
      kind: .show,
      title: "Canonical Show"
    )

    let page = try await client.loadChildren(
      for: selection,
      pageToken: "opaque-page-one",
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(
      page.items.map(\.identity) == [
        MediaIdentity("season-display-b"),
        MediaIdentity("season-display-a"),
      ])
    #expect(page.items.allSatisfy { $0.kind == .season })
    #expect(page.nextPageToken == "opaque-page-two")
    let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
    #expect(request.url?.path == "/nama.api.v1.LibraryService/ListChildren")
    let body = try #require(HomeConnectStubURLProtocol.recordedRequestBodies.first)
    let requestJSON = try #require(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )
    #expect(requestJSON["parentMediaId"] as? String == "opaque-show-parent")
    #expect(requestJSON["pageSize"] as? Int == 50)
    #expect(requestJSON["pageToken"] as? String == "opaque-page-one")
  }

  @Test("ListChildren maps ordered Episode positions without inventing runtime")
  func seasonChildrenMapEpisodePosition() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaChildrenAdapterFixture.seasonChildrenResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "tvos")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("opaque-season-parent"),
      kind: .season,
      title: "Season Two"
    )

    let page = try await client.loadChildren(
      for: selection,
      pageToken: nil,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(
      page.items.map(\.episodePosition) == [
        MediaEpisodePosition(seasonNumber: 2, episodeNumber: 7),
        MediaEpisodePosition(seasonNumber: 2, episodeNumber: 8),
      ])
    #expect(page.items.map(\.runtime) == [.seconds(1_800), nil])
    #expect(page.nextPageToken == nil)
  }

  @Test("PAGE_TOKEN_INVALID remains a distinct recoverable child-page failure")
  func invalidPageTokenMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MediaChildrenAdapterFixture.invalidPageTokenResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("show-expired-page"),
      kind: .show,
      title: "Expired Page Show"
    )

    await #expect(throws: MediaDetailsFailure.pageTokenInvalid) {
      try await client.loadChildren(
        for: selection,
        pageToken: "expired",
        authorization: movieDetailsAuthorization(record: record)
      )
    }
  }
}
