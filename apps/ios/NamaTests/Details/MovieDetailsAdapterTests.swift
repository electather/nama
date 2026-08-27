import Foundation
import Testing

@testable import Nama

private enum MovieDetailsAdapterFixture {
  static let clientVersion = "1.2.3"
  static let generation: UInt64 = 11
  static let releaseYear: UInt32 = 2_026
  static let runtimeSeconds: Int64 = 7_200
  static let runtime: Duration = .seconds(runtimeSeconds)
  static let tokenExpiry: TimeInterval = 4_600
  static let completeSynopsis =
    "A long canonical synopsis that remains complete instead of being truncated by the adapter."
  static let longSynopsisChunk = "Long canonical detail remains readable. "
  static let longSynopsisRepetitions = 400

  static let completeResponse = #"""
    {
      "media": {
        "summary": {
          "id": "movie-details",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "The Canonical Movie",
          "releaseYear": 2026,
          "runtime": "7200s",
          "contentRating": "PG-13",
          "primaryGenre": "Drama",
          "playability": "PLAYABILITY_PLAYABLE",
          "defaultSource": {
            "id": "source-default",
            "label": "4K HDR",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE",
            "container": "mkv"
          }
        },
        "tagline": "Everything changes at midnight.",
        "synopsis": "A long canonical synopsis that remains complete instead of being truncated by the adapter.",
        "genres": ["Drama", "Mystery"],
        "studios": ["North Star Pictures", "Harbor Films"],
        "credits": [
          {
            "name": "Ada Director",
            "role": "MEDIA_CREDIT_ROLE_DIRECTOR"
          },
          {
            "name": "Wes Writer",
            "role": "MEDIA_CREDIT_ROLE_WRITER"
          },
          {
            "name": "Sam Actor",
            "role": "MEDIA_CREDIT_ROLE_ACTOR",
            "characterName": "The Traveler",
            "portraitArtwork": {
              "id": "portrait-sam",
              "role": "ARTWORK_ROLE_PORTRAIT",
              "textPresence": "ARTWORK_TEXT_PRESENCE_UNKNOWN"
            }
          }
        ],
        "artwork": [
          {
            "id": "backdrop-textless",
            "role": "ARTWORK_ROLE_BACKDROP",
            "width": 1920,
            "height": 1080,
            "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
          },
          {
            "id": "poster-textless",
            "role": "ARTWORK_ROLE_POSTER",
            "width": 1000,
            "height": 1500,
            "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
          }
        ],
        "sourceSummaries": [
          {
            "id": "source-default",
            "label": "4K HDR",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE",
            "container": "mkv"
          }
        ],
        "movie": {
          "releaseDate": {
            "year": 2026,
            "month": 8,
            "day": 25
          }
        }
      }
    }
    """#
  static let minimalResponse = #"""
    {
      "media": {
        "summary": {
          "id": "movie-minimal",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "Minimal Movie",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        "movie": {}
      }
    }
    """#

  static let canonicalRequestID = "2f1c5f44-6a9b-4d2e-8c70-62df607c2efa"
  static let unsupportedDetail = #"""
    {
      "type": "google.rpc.ErrorInfo",
      "value": "ChpDTElFTlRfVkVSU0lPTl9VTlNVUFBPUlRFRBILbmFtYS5hcGkudjE="
    }
    """#
  static let requestDetail = #"""
    {
      "type": "google.rpc.RequestInfo",
      "value": "CiQyZjFjNWY0NC02YTliLTRkMmUtOGM3MC02MmRmNjA3YzJlZmE="
    }
    """#

  static func failureResponse(code: String, detail: String? = nil) -> String {
    let detailField = detail.map { ", \"details\": [\($0)]" } ?? ""
    return """
      {
        "code": "\(code)",
        "message": "safe failure"\(detailField)
      }
      """
  }
}

@Suite("Movie Details LibraryService adapter", .serialized)
@MainActor
struct MovieDetailsAdapterTests {
  @Test("GetMedia maps complete provider-neutral Movie Details")
  func completeResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MovieDetailsAdapterFixture.completeResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MovieDetailsSelection(
      identity: HomeMediaIdentity("movie-details"),
      title: "Home title"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.identity == selection.identity)
    #expect(details.title == "The Canonical Movie")
    #expect(details.releaseYear == MovieDetailsAdapterFixture.releaseYear)
    #expect(details.runtime == MovieDetailsAdapterFixture.runtime)
    #expect(details.contentRating == "PG-13")
    #expect(details.primaryGenre == "Drama")
    #expect(details.tagline == "Everything changes at midnight.")
    #expect(details.synopsis?.hasSuffix("truncated by the adapter.") == true)
    #expect(details.genres == ["Drama", "Mystery"])
    #expect(details.studios == ["North Star Pictures", "Harbor Films"])
    #expect(details.credits.map(\.name) == ["Ada Director", "Wes Writer", "Sam Actor"])
    #expect(details.credits.map(\.role) == [.director, .writer, .actor])
    #expect(details.credits.last?.characterName == "The Traveler")
    #expect(details.credits.last?.portraitArtwork?.identity == HomeArtworkIdentity("portrait-sam"))
    #expect(details.preferredBackdropArtwork?.identity == HomeArtworkIdentity("backdrop-textless"))
    #expect(details.preferredPosterArtwork?.identity == HomeArtworkIdentity("poster-textless"))
    #expect(details.playability == .playable)
    #expect(details.defaultSource?.identity == HomeSourceIdentity("source-default"))
    try assertMovieDetailsRequest()
  }

  @Test("GetMedia preserves a long synopsis")
  func longSynopsisMapping() async throws {
    let longSynopsis = String(
      repeating: MovieDetailsAdapterFixture.longSynopsisChunk,
      count: MovieDetailsAdapterFixture.longSynopsisRepetitions
    )
    let response = MovieDetailsAdapterFixture.completeResponse.replacingOccurrences(
      of: MovieDetailsAdapterFixture.completeSynopsis,
      with: longSynopsis
    )
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: response
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "macos")
    let selection = MovieDetailsSelection(
      identity: HomeMediaIdentity("movie-details"),
      title: "Home title"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.synopsis == longSynopsis)
  }

  @Test("GetMedia preserves mandatory identity when optional metadata is missing")
  func missingOptionalMetadataMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MovieDetailsAdapterFixture.minimalResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "tvos")
    let selection = MovieDetailsSelection(
      identity: HomeMediaIdentity("movie-minimal"),
      title: "Home title"
    )

    let details = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )

    #expect(details.identity == selection.identity)
    #expect(details.title == "Minimal Movie")
    #expect(details.releaseYear == nil)
    #expect(details.runtime == nil)
    #expect(details.contentRating == nil)
    #expect(details.primaryGenre == nil)
    #expect(details.tagline == nil)
    #expect(details.synopsis == nil)
    #expect(details.genres.isEmpty)
    #expect(details.studios.isEmpty)
    #expect(details.credits.isEmpty)
    #expect(details.preferredBackdropArtwork == nil)
    #expect(details.preferredPosterArtwork == nil)
    #expect(details.playability == .noAvailableSource)
    #expect(details.defaultSource == nil)
  }

  @Test("GetMedia keeps failure classes distinct")
  func failureMapping() async throws {
    let cases: [(String, MovieDetailsFailure)] = [
      (
        MovieDetailsAdapterFixture.failureResponse(code: "not_found"),
        .notFound
      ),
      (
        MovieDetailsAdapterFixture.failureResponse(code: "deadline_exceeded"),
        .transportUnavailable
      ),
      (
        MovieDetailsAdapterFixture.failureResponse(code: "unauthenticated"),
        .authorizationUnavailable
      ),
      (
        MovieDetailsAdapterFixture.failureResponse(
          code: "failed_precondition",
          detail: MovieDetailsAdapterFixture.unsupportedDetail
        ),
        .incompatible
      ),
      (
        MovieDetailsAdapterFixture.failureResponse(
          code: "internal",
          detail: MovieDetailsAdapterFixture.requestDetail
        ),
        .namaUnavailable(requestID: MovieDetailsAdapterFixture.canonicalRequestID)
      ),
    ]
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MovieDetailsSelection(
      identity: HomeMediaIdentity("movie-details"),
      title: "Home title"
    )

    for (body, expectedFailure) in cases {
      HomeConnectStubURLProtocol.configure(
        status: HomeTransportFixture.unavailableHTTPStatus,
        body: body
      )
      await #expect(throws: expectedFailure) {
        try await client.load(
          selection,
          authorization: movieDetailsAuthorization(record: record)
        )
      }
    }
    HomeConnectStubURLProtocol.reset()
  }

  @Test("cancelled GetMedia work sends no request")
  func cancellationBeforeRequest() async throws {
    HomeConnectStubURLProtocol.reset()
    let record = try movieDetailsTokenRecord()
    let store = SuspendedMovieDetailsTokenStore()
    let client = NamaLibraryClient(
      clientVersion: MovieDetailsAdapterFixture.clientVersion,
      tokenStore: store,
      sessionConfiguration: homeStubConfiguration(),
      platform: "ios"
    )
    let selection = MovieDetailsSelection(
      identity: HomeMediaIdentity("movie-details"),
      title: "Home title"
    )
    let task = Task {
      try await client.load(
        selection,
        authorization: movieDetailsAuthorization(record: record)
      )
    }
    await eventually { await store.loadCallCount == 1 }

    task.cancel()
    await store.resolve(with: .record(record))

    await #expect(throws: CancellationError.self) {
      try await task.value
    }
    #expect(HomeConnectStubURLProtocol.recordedRequests.isEmpty)
  }
}

@MainActor
private func movieDetailsClient(
  record: EndpointBoundOAuthTokenRecord,
  platform: String
) -> NamaLibraryClient {
  NamaLibraryClient(
    clientVersion: MovieDetailsAdapterFixture.clientVersion,
    tokenStore: InMemoryOAuthTokenStore(snapshot: .record(record)),
    sessionConfiguration: homeStubConfiguration(),
    platform: platform
  )
}

private func movieDetailsAuthorization(
  record: EndpointBoundOAuthTokenRecord
) -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: record.endpoint,
    accessTokenExpiresAt: record.accessTokenExpiresAt,
    generation: MovieDetailsAdapterFixture.generation
  )
}

@MainActor
private func assertMovieDetailsRequest() throws {
  let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
  #expect(request.url?.path == "/nama.api.v1.LibraryService/GetMedia")
  #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer access-token-secret")
  #expect(request.value(forHTTPHeaderField: "nama-client-platform") == "ios")
  let body = try #require(HomeConnectStubURLProtocol.recordedRequestBodies.first)
  let requestJSON = try #require(
    JSONSerialization.jsonObject(with: body) as? [String: Any]
  )
  #expect(requestJSON["mediaId"] as? String == "movie-details")
}

private func movieDetailsTokenRecord() throws -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    accessTokenExpiresAt: Date(timeIntervalSince1970: MovieDetailsAdapterFixture.tokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}
