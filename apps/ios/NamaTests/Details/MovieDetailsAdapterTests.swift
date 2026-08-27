import Foundation
import Testing

@testable import Nama

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
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-details"),
      kind: .movie,
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
    #expect(details.credits.last?.portraitArtwork?.identity == ArtworkIdentity("portrait-sam"))
    #expect(details.preferredBackdropArtwork?.identity == ArtworkIdentity("backdrop-textless"))
    #expect(details.preferredPosterArtwork?.identity == ArtworkIdentity("poster-textless"))
    #expect(details.playability == .playable)
    #expect(details.defaultSource?.identity == MediaSourceIdentity("source-default"))
    #expect(details.sourceSummaries.map(\.identity) == [MediaSourceIdentity("source-default")])
    try assertMovieDetailsRequest()
  }

  @Test("credit identity survives an earlier insertion")
  func creditIdentitySurvivesInsertion() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MovieDetailsAdapterFixture.completeResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-details"),
      kind: .movie,
      title: "Home title"
    )
    let original = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )
    let responseWithEarlierCredit =
      MovieDetailsAdapterFixture.completeResponse.replacingOccurrences(
        of: #""credits": ["#,
        with: #""credits": [{"name":"Earlier Actor","role":"MEDIA_CREDIT_ROLE_ACTOR"},"#
      )
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: responseWithEarlierCredit
    )

    let refreshed = try await client.load(
      selection,
      authorization: movieDetailsAuthorization(record: record)
    )
    let originalActor = try #require(original.credits.first { $0.name == "Sam Actor" })
    let refreshedActor = try #require(refreshed.credits.first { $0.name == "Sam Actor" })

    #expect(refreshedActor.identity == originalActor.identity)
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
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-details"),
      kind: .movie,
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
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-minimal"),
      kind: .movie,
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
    let cases: [(String, MediaDetailsFailure)] = [
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
        .namaUnavailable(
          requestID: MovieDetailsAdapterFixture.canonicalRequestID,
          retryAfterSeconds: nil
        )
      ),
    ]
    try await assertMediaDetailsFailureMappings(cases)
  }

  @Test("GetMedia preserves server retry guidance")
  func retryGuidanceMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(
        code: "resource_exhausted",
        detail: MovieDetailsAdapterFixture.rateLimitedDetail,
        additionalDetails: [MovieDetailsAdapterFixture.retryFiveSecondsDetail]
      )
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-details"),
      kind: .movie,
      title: "Home title"
    )

    await #expect(
      throws: MediaDetailsFailure.namaUnavailable(
        requestID: nil,
        retryAfterSeconds: 5
      )
    ) {
      try await client.load(
        selection,
        authorization: movieDetailsAuthorization(record: record)
      )
    }
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
    let selection = MediaDetailsSelection(
      identity: MediaIdentity("movie-details"),
      kind: .movie,
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
private func assertMediaDetailsFailureMappings(
  _ cases: [(String, MediaDetailsFailure)]
) async throws {
  let record = try movieDetailsTokenRecord()
  let client = movieDetailsClient(record: record, platform: "ios")
  let selection = MediaDetailsSelection(
    identity: MediaIdentity("movie-details"),
    kind: .movie,
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

@MainActor
func movieDetailsClient(
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

func movieDetailsAuthorization(
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

func movieDetailsTokenRecord() throws -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessToken: "access-token-secret",
    refreshToken: "refresh-token-secret",
    accessTokenExpiresAt: Date(timeIntervalSince1970: MovieDetailsAdapterFixture.tokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}
