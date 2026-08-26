import Foundation
import Testing

@testable import Nama

@Suite("OAuth authorization retry")
@MainActor
struct OAuthAuthorizationRetryTests {
  @Test("retry after a transient failure resumes expiry-driven refresh")
  func retryResumesRefreshLifecycle() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let active = retryActiveRecord(endpoint: endpoint)
    let client = retryClient()
    let store = InMemoryOAuthTokenStore(snapshot: .record(active))
    let verifier = SequenceOAuthScopedAccessVerifier(
      errors: [.invalidResponse, nil, nil]
    )
    let sleep = TwoCycleOAuthSleep()
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: verifier,
      now: { Date(timeIntervalSince1970: RetryFixture.now) },
      sleep: sleep.callAsFunction
    )

    await feature.authorize(endpoint)
    #expect(feature.state == .failed(endpoint, .invalidResponse))

    await feature.run(endpoint)

    #expect(await client.refreshedTokens == ["current-refresh-token"])
    #expect(
      await sleep.durations == [
        .seconds(RetryFixture.refreshDelay),
        .seconds(RetryFixture.refreshedTokenLifetime),
      ]
    )
    #expect(await verifier.records.count == RetryFixture.verificationCount)
    #expect(await store.record?.refreshToken == "rotated-refresh-token")
    if case .authorized(let status) = feature.state {
      #expect(status.endpoint == endpoint)
    } else {
      Issue.record("retry did not restore authorization")
    }
  }
}

nonisolated private enum RetryFixture {
  static let now: TimeInterval = 1_000
  static let accessTokenExpiry: TimeInterval = 1_100
  static let refreshedTokenLifetime: TimeInterval = 3_600
  static let refreshDelay: Int64 = 100
  static let verificationCount = 3
}

private func retryActiveRecord(endpoint: NamaEndpoint) -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: endpoint,
    accessToken: "active-access-token",
    refreshToken: "current-refresh-token",
    accessTokenExpiresAt: Date(timeIntervalSince1970: RetryFixture.accessTokenExpiry),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}

private func retryClient() -> InMemoryOAuthAuthorizationClient {
  InMemoryOAuthAuthorizationClient(
    deviceAuthorization: nil,
    pollResults: [],
    refreshResult: .success(
      OAuthTokenBundle(
        accessToken: "fresh-access-token",
        refreshToken: "rotated-refresh-token",
        expiresIn: RetryFixture.refreshedTokenLifetime,
        scope: OAuthConfiguration.consumerScopes,
        tokenType: "Bearer"
      )
    )
  )
}
