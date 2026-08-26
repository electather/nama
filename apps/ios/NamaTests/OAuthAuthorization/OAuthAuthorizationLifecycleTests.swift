import Foundation
import Testing

@testable import Nama

@Suite("OAuth authorization lifecycle")
@MainActor
struct OAuthAuthorizationLifecycleTests {
  @Test("an expired access token rotates through refresh and publishes only the committed bundle")
  func refreshRotationCommitsBeforePublishing() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let expired = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "expired-access-token",
      refreshToken: "current-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 999),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let refreshed = OAuthTokenBundle(
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3_600,
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: nil,
      pollResults: [],
      refreshResult: .success(refreshed)
    )
    let store = InMemoryOAuthTokenStore(snapshot: .record(expired))
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: { _ in
        // Deterministic authorization proceeds without a wall-clock delay.
      }
    )

    await feature.authorize(endpoint)

    let expected = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    #expect(await client.refreshedTokens == ["current-refresh-token"])
    #expect(await store.record == expected)
    #expect(
      feature.state == .authorized(OAuthAuthorizationStatus(record: expected))
    )
    #expect(
      HomeAuthorizationIdentity(
        currentEndpoint: endpoint,
        authorizationState: feature.state,
        generation: feature.session.generation
      ) != nil
    )
  }

  @Test("rejected Home authorization retries exact bundle removal")
  func rejectedHomeAuthorizationIsDiscarded() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "rejected-access-token",
      refreshToken: "rejected-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let store = InMemoryOAuthTokenStore(
      snapshot: .record(record),
      removalFailures: 1
    )
    let session = OAuthAuthorizationSession()
    let feature = OAuthAuthorizationFeature(
      client: InMemoryOAuthAuthorizationClient(deviceAuthorization: nil, pollResults: []),
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      session: session,
      now: { Date(timeIntervalSince1970: 1_000) }
    )
    let otherWindow = OAuthAuthorizationFeature(
      client: InMemoryOAuthAuthorizationClient(deviceAuthorization: nil, pollResults: []),
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      session: session,
      now: { Date(timeIntervalSince1970: 1_000) }
    )
    await feature.authorize(endpoint)
    await otherWindow.authorize(endpoint)
    let rejected = try #require(session.authorization)
    let generation = session.generation

    let firstDiscard = await feature.discardRejectedAuthorization(
      rejected,
      generation: generation
    )

    #expect(firstDiscard == .storageUnavailable)
    #expect(await store.record == record)
    #expect(session.authorization == nil)
    #expect(session.pendingDiscard?.authorization == rejected)
    #expect(session.failure == .authorizationResetUnavailable)
    #expect(otherWindow.state == .failed(endpoint, .authorizationResetUnavailable))

    let resumedDiscard = await feature.resumePendingAuthorizationDiscard(
      at: endpoint
    )

    #expect(resumedDiscard == .discarded)
    #expect(await store.record == nil)
    #expect(session.pendingDiscard == nil)
    #expect(session.failure == .authorizationExpired)
  }

  @Test("damaged rejected authorization is quarantined before retry")
  func damagedRejectedAuthorizationIsQuarantined() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let record = activeLifecycleRecord(endpoint: endpoint)
    let store = InMemoryOAuthTokenStore(snapshot: .record(record))
    let feature = OAuthAuthorizationFeature(
      client: InMemoryOAuthAuthorizationClient(deviceAuthorization: nil, pollResults: []),
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      now: { Date(timeIntervalSince1970: 1_000) }
    )
    await feature.authorize(endpoint)
    let rejected = try #require(feature.session.authorization)
    let generation = feature.session.generation
    let damaged = Data("damaged-token-record".utf8)
    await store.damage(damaged)

    let outcome = await feature.discardRejectedAuthorization(
      rejected,
      generation: generation
    )

    #expect(outcome == .discarded)
    #expect(await store.quarantined == [damaged])
    #expect(feature.session.authorization == nil)
  }

  @Test("an active authorization refreshes when its access token reaches expiry")
  func activeAuthorizationRefreshesAtExpiry() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let active = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "active-access-token",
      refreshToken: "current-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 1_100),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let refreshed = OAuthTokenBundle(
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      expiresIn: 3_600,
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: nil,
      pollResults: [],
      refreshResult: .success(refreshed)
    )
    let store = InMemoryOAuthTokenStore(snapshot: .record(active))
    let sleep = TwoCycleOAuthSleep()
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: sleep.callAsFunction
    )

    await feature.run(endpoint)

    let expected = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "fresh-access-token",
      refreshToken: "rotated-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    #expect(await sleep.durations == [.seconds(100), .seconds(3_600)])
    #expect(await client.refreshedTokens == ["current-refresh-token"])
    #expect(await store.record == expected)
    #expect(
      feature.state == .authorized(OAuthAuthorizationStatus(record: expected))
    )
    #expect(
      HomeAuthorizationIdentity(
        currentEndpoint: endpoint,
        authorizationState: feature.state,
        generation: feature.session.generation
      ) != nil
    )
  }

  @Test("window-local tasks share active authorization without canceling another refresh loop")
  func windowLocalTasksShareActiveAuthorization() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let active = activeLifecycleRecord(endpoint: endpoint)
    let client = successfulRefreshClient()
    let store = InMemoryOAuthTokenStore(snapshot: .record(active))
    let session = OAuthAuthorizationSession()
    let firstSleep = GatedRefreshOAuthSleep()
    let secondSleep = GatedRefreshOAuthSleep()
    let first = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      session: session,
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: firstSleep.callAsFunction
    )
    let second = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      session: session,
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: secondSleep.callAsFunction
    )

    let firstRun = Task { await first.run(endpoint) }
    await firstSleep.waitUntilStarted()
    let secondRun = Task { await second.run(endpoint) }
    await secondSleep.waitUntilStarted()

    secondRun.cancel()
    await secondSleep.resume()
    await secondRun.value
    await firstSleep.resume()
    await firstRun.value

    #expect(await client.refreshedTokens == ["current-refresh-token"])
    if case .authorized(let firstRecord) = first.state,
      case .authorized(let secondRecord) = second.state
    {
      #expect(firstRecord.accessTokenExpiresAt == Date(timeIntervalSince1970: 4_600))
      #expect(secondRecord == firstRecord)
    } else {
      Issue.record("windows did not observe the shared refreshed authorization")
    }
  }

  @Test("retry after a transient failure resumes expiry-driven refresh")
  func retryResumesRefreshLifecycle() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let active = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "active-access-token",
      refreshToken: "current-refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 1_100),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: nil,
      pollResults: [],
      refreshResult: .success(
        OAuthTokenBundle(
          accessToken: "fresh-access-token",
          refreshToken: "rotated-refresh-token",
          expiresIn: 3_600,
          scope: OAuthConfiguration.consumerScopes,
          tokenType: "Bearer"
        )
      )
    )
    let store = InMemoryOAuthTokenStore(snapshot: .record(active))
    let verifier = SequenceOAuthScopedAccessVerifier(
      errors: [.invalidResponse, nil, nil]
    )
    let sleep = TwoCycleOAuthSleep()
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: verifier,
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: sleep.callAsFunction
    )

    await feature.authorize(endpoint)
    #expect(feature.state == .failed(endpoint, .invalidResponse))

    await feature.run(endpoint)

    #expect(await client.refreshedTokens == ["current-refresh-token"])
    #expect(await sleep.durations == [.seconds(100), .seconds(3_600)])
    #expect(await verifier.records.count == 3)
    #expect(await store.record?.refreshToken == "rotated-refresh-token")
    if case .authorized(let status) = feature.state {
      #expect(status.endpoint == endpoint)
    } else {
      Issue.record("retry did not restore authorization")
    }
  }
}

private enum LifecycleFixture {
  static let accessTokenExpiresAt: TimeInterval = 1_100
  static let refreshedTokenLifetime: TimeInterval = 3_600
}

private func activeLifecycleRecord(endpoint: NamaEndpoint) -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: endpoint,
    accessToken: "active-access-token",
    refreshToken: "current-refresh-token",
    accessTokenExpiresAt: Date(timeIntervalSince1970: LifecycleFixture.accessTokenExpiresAt),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}

private func successfulRefreshClient() -> InMemoryOAuthAuthorizationClient {
  InMemoryOAuthAuthorizationClient(
    deviceAuthorization: nil,
    pollResults: [],
    refreshResult: .success(
      OAuthTokenBundle(
        accessToken: "fresh-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: LifecycleFixture.refreshedTokenLifetime,
        scope: OAuthConfiguration.consumerScopes,
        tokenType: "Bearer"
      )
    )
  )
}
