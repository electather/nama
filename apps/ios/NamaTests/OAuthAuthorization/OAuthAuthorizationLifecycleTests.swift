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
      sleep: { _ in }
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
  }

  @Test("window-local tasks share active authorization without canceling another refresh loop")
  func windowLocalTasksShareActiveAuthorization() async throws {
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
