import Foundation
import Testing

@testable import Nama

private enum MediaDetailsKindAdapterFixture {
  static let catalogRetrySeconds = 9
  static let showResponse = #"""
    {
      "media": {
        "summary": {
          "id": "show-details",
          "kind": "MEDIA_KIND_SHOW",
          "title": "The Canonical Show",
          "releaseYear": 2024,
          "contentRating": "TV-14",
          "primaryGenre": "Drama",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        "parents": [],
        "show": {
          "firstReleaseDate": {
            "year": 2024,
            "month": 9,
            "day": 12
          },
          "lastReleaseDate": {
            "year": 2026,
            "month": 4,
            "day": 3
          },
          "seasonCount": 3,
          "episodeCount": 24
        }
      }
    }
    """#
  static let seasonResponse = #"""
    {
      "media": {
        "summary": {
          "id": "opaque-season",
          "kind": "MEDIA_KIND_SEASON",
          "title": "Season Three",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        "parents": [
          {
            "id": "opaque-show",
            "kind": "MEDIA_KIND_SHOW",
            "title": "The Canonical Show"
          }
        ],
        "season": {
          "seasonNumber": 3
        }
      }
    }
    """#
  static let episodeResponse = #"""
    {
      "media": {
        "summary": {
          "id": "opaque-episode",
          "kind": "MEDIA_KIND_EPISODE",
          "title": "A Deliberately Long Episode Title That Must Remain Complete",
          "releaseYear": 2026,
          "runtime": "3600s",
          "contentRating": "TV-14",
          "primaryGenre": "Drama",
          "episodePosition": {
            "seasonNumber": 3,
            "episodeNumber": 4
          },
          "playability": "PLAYABILITY_PLAYABLE",
          "defaultSource": {
            "id": "episode-source",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE"
          }
        },
        "parents": [
          {
            "id": "opaque-show",
            "kind": "MEDIA_KIND_SHOW",
            "title": "The Canonical Show"
          },
          {
            "id": "opaque-season",
            "kind": "MEDIA_KIND_SEASON",
            "title": "Season Three"
          }
        ],
        "sourceSummaries": [
          {
            "id": "episode-source",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE"
          }
        ],
        "episode": {
          "seasonNumber": 3,
          "episodeNumber": 4,
          "releaseDate": {
            "year": 2026,
            "month": 2,
            "day": 19
          }
        }
      }
    }
    """#
  static let invalidMonthOnlyDateResponse = #"""
    {
      "media": {
        "summary": {
          "id": "show-invalid-date",
          "kind": "MEDIA_KIND_SHOW",
          "title": "Invalid Date Show",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        "show": {
          "firstReleaseDate": {
            "month": 9
          }
        }
      }
    }
    """#
}

@Suite("Show, Season, and Episode Details adapter", .serialized)
@MainActor
struct MediaDetailsKindAdapterTests {
  @Test("GetMedia maps only canonical Show fields")
  func showResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaDetailsKindAdapterFixture.showResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("show-details"),
      kind: .show,
      title: "Home Show"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.identity == selection.identity)
    #expect(details.title == "The Canonical Show")
    #expect(details.runtime == nil)
    #expect(
      details.kindDetails
        == .show(
          firstReleaseDate: MediaCalendarDate(year: 2_024, month: 9, day: 12),
          lastReleaseDate: MediaCalendarDate(year: 2_026, month: 4, day: 3),
          seasonCount: 3,
          episodeCount: 24
        )
    )
    #expect(details.parents.isEmpty)
  }

  @Test("an ID-only restored selection reloads canonical Details from GetMedia")
  func restoredSelectionMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaDetailsKindAdapterFixture.showResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(restoredIdentity: MediaIdentity("show-details"))

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.kindDetails.mediaKind == .show)
    #expect(details.title == "The Canonical Show")
    let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
    #expect(request.url?.path == "/nama.api.v1.LibraryService/GetMedia")
    let body = try #require(HomeConnectStubURLProtocol.recordedRequestBodies.first)
    let requestJSON = try #require(
      JSONSerialization.jsonObject(with: body) as? [String: Any]
    )
    #expect(requestJSON["mediaId"] as? String == "show-details")
  }

  @Test("GetMedia maps a direct opaque Season with canonical Show parent")
  func seasonResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaDetailsKindAdapterFixture.seasonResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "macos")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("opaque-season"),
      kind: .season,
      title: "Search result title"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.kindDetails == .season(seasonNumber: 3, episodeCount: nil))
    #expect(details.runtime == nil)
    #expect(details.parents.count == 1)
    #expect(
      details.parents.first
        == MediaDetailsParent(
          identity: MediaIdentity("opaque-show"),
          kind: .show,
          title: "The Canonical Show"
        )
    )
  }

  @Test("GetMedia maps a direct playable Episode with canonical parent context")
  func episodeResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaDetailsKindAdapterFixture.episodeResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "tvos")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("opaque-episode"),
      kind: .episode,
      title: "Search result title"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.title == "A Deliberately Long Episode Title That Must Remain Complete")
    #expect(details.runtime == .seconds(3_600))
    #expect(
      details.kindDetails
        == .episode(
          seasonNumber: 3,
          episodeNumber: 4,
          releaseDate: MediaCalendarDate(year: 2_026, month: 2, day: 19)
        )
    )
    #expect(
      details.parents == [
        MediaDetailsParent(
          identity: MediaIdentity("opaque-show"),
          kind: .show,
          title: "The Canonical Show"
        ),
        MediaDetailsParent(
          identity: MediaIdentity("opaque-season"),
          kind: .season,
          title: "Season Three"
        ),
      ]
    )
    #expect(details.playability == .playable)
  }

  @Test("GetMedia rejects a month-only date instead of inventing a day")
  func monthOnlyDateIsIncompatible() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaDetailsKindAdapterFixture.invalidMonthOnlyDateResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("show-invalid-date"),
      kind: .show,
      title: "Invalid Date Show"
    )

    await #expect(throws: MediaDetailsFailure.incompatible) {
      try await client.load(
        selection,
        authorization: movieDetailsAuthorization(record: record)
      )
    }
  }

  @Test("CATALOG_NOT_READY preserves bounded preparation guidance")
  func catalogNotReadyMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: HomeTransportFixture.catalogNotReadyResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("show-catalog-preparation"),
      kind: .show,
      title: "Preparing Show"
    )

    await #expect(
      throws: MediaDetailsFailure.catalogNotReady(
        retryAfterSeconds: MediaDetailsKindAdapterFixture.catalogRetrySeconds
      )
    ) {
      try await client.load(
        selection,
        authorization: movieDetailsAuthorization(record: record)
      )
    }
  }
}
