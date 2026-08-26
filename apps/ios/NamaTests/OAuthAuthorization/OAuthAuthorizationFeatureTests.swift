import Foundation
import Testing

@testable import Nama

@Suite("OAuth device authorization")
@MainActor
struct OAuthAuthorizationFeatureTests {
  @Test("polling waits for every server-returned interval before committing the token bundle")
  func pollingUsesReturnedInterval() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let deviceAuthorization = OAuthDeviceAuthorization(
      deviceCode: "device-code-secret",
      userCode: "ABCD-EFGH",
      verificationURI: endpoint.appending(path: "device"),
      expiresIn: 600,
      interval: 7
    )
    let token = OAuthTokenBundle(
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      expiresIn: 3_600,
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: deviceAuthorization,
      pollResults: [.pending, .authorized(token)]
    )
    let store = InMemoryOAuthTokenStore(snapshot: .missing)
    let sleep = RecordingOAuthSleep()
    let scopedAccessVerifier = InMemoryOAuthScopedAccessVerifier()
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: scopedAccessVerifier,
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: sleep.callAsFunction
    )

    await feature.authorize(endpoint)

    #expect(await sleep.durations == [.seconds(7), .seconds(7)])
    #expect(await client.requestedEndpoints == [endpoint])
    #expect(await client.polledDeviceCodes == ["device-code-secret", "device-code-secret"])
    let expectedRecord = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "access-token-secret",
      refreshToken: "refresh-token-secret",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    #expect(await store.record == expectedRecord)
    #expect(await scopedAccessVerifier.records == [expectedRecord])
    #expect(
      feature.state == .authorized(OAuthAuthorizationStatus(record: expectedRecord))
    )
    #expect(
      HomeAuthorizationIdentity(
        currentEndpoint: endpoint,
        authorizationState: feature.state,
        generation: feature.session.generation
      ) != nil
    )
  }

  @Test("a token rejected by the scoped consumer call is never committed")
  func rejectedScopedAccessIsNotCommitted() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let invalidBundle = OAuthTokenBundle(
      accessToken: "invalid-access-token",
      refreshToken: "candidate-refresh-token",
      expiresIn: 3_600,
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: OAuthDeviceAuthorization(
        deviceCode: "candidate-device-code",
        userCode: "WXYZ-1234",
        verificationURI: endpoint.appending(path: "device"),
        expiresIn: 600,
        interval: 5
      ),
      pollResults: [.authorized(invalidBundle)]
    )
    let store = InMemoryOAuthTokenStore(snapshot: .missing)
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(error: .invalidResponse),
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: { _ in
        // Deterministic authorization proceeds without a wall-clock delay.
      }
    )

    await feature.authorize(endpoint)

    #expect(await store.record == nil)
    #expect(feature.state == .failed(endpoint, .invalidResponse))
  }

  @Test("a failed replacement commit preserves the previous endpoint authorization")
  func failedReplacementPreservesPreviousRecord() async throws {
    let previousEndpoint = try NamaEndpoint("https://old.nama.example.test")
    let candidateEndpoint = try NamaEndpoint("https://new.nama.example.test")
    let previous = tokenRecord(
      endpoint: previousEndpoint,
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 5_000
    )
    let client = replacementClient(for: candidateEndpoint)
    let store = InMemoryOAuthTokenStore(snapshot: .record(previous), replaceError: .unavailable)
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: InMemoryOAuthScopedAccessVerifier(),
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: { _ in
        // Deterministic authorization proceeds without a wall-clock delay.
      }
    )

    await feature.authorize(candidateEndpoint)

    #expect(await store.record == previous)
    #expect(feature.state == .failed(candidateEndpoint, .tokenStorageUnavailable))
  }

  @Test("cancellation restores the latest durable authorization instead of a stale snapshot")
  func cancelledReplacementRestoresLatestRecord() async throws {
    let previousEndpoint = try NamaEndpoint("https://old.nama.example.test")
    let candidateEndpoint = try NamaEndpoint("https://new.nama.example.test")
    let previous = tokenRecord(
      endpoint: previousEndpoint,
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 5_000
    )
    let newer = tokenRecord(
      endpoint: previousEndpoint,
      accessToken: "newer-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: 6_000
    )
    let client = replacementClient(for: candidateEndpoint)
    let store = SuspendingReplacementOAuthTokenStore(record: previous)
    let verifier = GatedOAuthScopedAccessVerifier()
    let session = OAuthAuthorizationSession()
    let feature = OAuthAuthorizationFeature(
      client: client,
      tokenStore: store,
      scopedAccessVerifier: verifier,
      session: session,
      now: { Date(timeIntervalSince1970: 1_000) },
      sleep: { _ in
        // Deterministic authorization proceeds without a wall-clock delay.
      }
    )

    let authorization = Task {
      await feature.authorize(candidateEndpoint)
    }
    await verifier.waitUntilStarted()
    await store.setRecord(newer)
    session.publish(newer)
    await verifier.resume()
    await store.waitUntilReplacementStarts()
    authorization.cancel()
    await store.resumeReplacement()
    _ = await authorization.value

    #expect(await store.record == newer)
    #expect(session.authorization == OAuthAuthorizationStatus(record: newer))
    if case .authorized(let status) = feature.state {
      #expect(status.endpoint != candidateEndpoint)
    }
  }

  @Test("a damaged Keychain record is quarantined before new device authorization")
  func damagedRecordIsQuarantined() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let damaged = Data("not-a-token-record".utf8)
    let client = InMemoryOAuthAuthorizationClient(
      deviceAuthorization: OAuthDeviceAuthorization(
        deviceCode: "new-device-code",
        userCode: "ABCD-EFGH",
        verificationURI: endpoint.appending(path: "device"),
        expiresIn: 600,
        interval: 5
      ),
      pollResults: [.denied]
    )
    let store = InMemoryOAuthTokenStore(snapshot: .damaged(damaged))
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

    #expect(await store.quarantined == [damaged])
    #expect(await client.requestedEndpoints == [endpoint])
    #expect(feature.state == .failed(endpoint, .accessDenied))
  }
}

private enum ReplacementFixture {
  static let deviceAuthorizationLifetime: TimeInterval = 600
  static let pollingInterval: TimeInterval = 5
  static let tokenLifetime: TimeInterval = 3_600
}

private func tokenRecord(
  endpoint: NamaEndpoint,
  accessToken: String,
  refreshToken: String,
  expiresAt: TimeInterval
) -> EndpointBoundOAuthTokenRecord {
  EndpointBoundOAuthTokenRecord(
    endpoint: endpoint,
    accessToken: accessToken,
    refreshToken: refreshToken,
    accessTokenExpiresAt: Date(timeIntervalSince1970: expiresAt),
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
}

private func replacementClient(for endpoint: NamaEndpoint) -> InMemoryOAuthAuthorizationClient {
  let bundle = OAuthTokenBundle(
    accessToken: "candidate-access-token",
    refreshToken: "candidate-refresh-token",
    expiresIn: ReplacementFixture.tokenLifetime,
    scope: OAuthConfiguration.consumerScopes,
    tokenType: "Bearer"
  )
  return InMemoryOAuthAuthorizationClient(
    deviceAuthorization: OAuthDeviceAuthorization(
      deviceCode: "candidate-device-code",
      userCode: "WXYZ-1234",
      verificationURI: endpoint.appending(path: "device"),
      expiresIn: ReplacementFixture.deviceAuthorizationLifetime,
      interval: ReplacementFixture.pollingInterval
    ),
    pollResults: [.authorized(bundle)]
  )
}
