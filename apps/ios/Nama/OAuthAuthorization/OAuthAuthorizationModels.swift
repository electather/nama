import Foundation
import Observation

nonisolated enum OAuthConfiguration {
  static let applePublicClientID = "nama-apple"
  static let libraryScope = "nama:library"
  static let playbackScope = "nama:playback"
  static let userStateScope = "nama:user-state"
  static let offlineAccessScope = "offline_access"
  static let consumerScopes = [
    libraryScope,
    playbackScope,
    userStateScope,
  ]
  static let authorizationScopes = consumerScopes + [offlineAccessScope]
  static let deviceCodeGrant = "urn:ietf:params:oauth:grant-type:device_code"
}

nonisolated struct OAuthDeviceAuthorization: Equatable, Sendable {
  let deviceCode: String
  let userCode: String
  let verificationURI: URL
  let expiresIn: TimeInterval
  let interval: TimeInterval
}

nonisolated struct OAuthTokenMaterial: Equatable, Sendable {
  let accessToken: String
  let refreshToken: String
  let scope: [String]
  let tokenType: String

  init?(
    accessToken: String,
    refreshToken: String,
    scope: [String],
    tokenType: String
  ) {
    guard
      !accessToken.isEmpty,
      !refreshToken.isEmpty,
      tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
      Set(scope) == Set(OAuthConfiguration.consumerScopes),
      scope.count == OAuthConfiguration.consumerScopes.count
    else {
      return nil
    }
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.scope = OAuthConfiguration.consumerScopes
    self.tokenType = "Bearer"
  }
}

nonisolated struct OAuthTokenBundle: Equatable, Sendable {
  let accessToken: String
  let refreshToken: String
  let expiresIn: TimeInterval
  let scope: [String]
  let tokenType: String
}

nonisolated struct EndpointBoundOAuthTokenRecord: Codable, Equatable, Sendable {
  let endpoint: NamaEndpoint
  let accessToken: String
  let refreshToken: String
  let accessTokenExpiresAt: Date
  let scope: [String]
  let tokenType: String

  private static let currentVersion = 1

  private struct CodingKeys: CodingKey {
    static let version = Self("version")
    static let endpoint = Self("endpoint")
    static let accessToken = Self("accessToken")
    static let refreshToken = Self("refreshToken")
    static let accessTokenExpiresAt = Self("accessTokenExpiresAt")
    static let scope = Self("scope")
    static let tokenType = Self("tokenType")

    let stringValue: String
    let intValue: Int?

    private init(_ value: String) {
      stringValue = value
      intValue = nil
    }

    init?(stringValue value: String) {
      self.init(value)
    }

    init?(intValue _: Int) {
      nil
    }
  }

  init(
    endpoint: NamaEndpoint,
    accessToken: String,
    refreshToken: String,
    accessTokenExpiresAt: Date,
    scope: [String],
    tokenType: String
  ) {
    self.endpoint = endpoint
    self.accessToken = accessToken
    self.refreshToken = refreshToken
    self.accessTokenExpiresAt = accessTokenExpiresAt
    self.scope = scope
    self.tokenType = tokenType
  }

  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    guard try values.decode(Int.self, forKey: .version) == Self.currentVersion else {
      throw OAuthTokenRecordError.unsupportedVersion
    }
    let endpointText = try values.decode(String.self, forKey: .endpoint)
    guard let decodedEndpoint = try? NamaEndpoint(endpointText) else {
      throw OAuthTokenRecordError.invalid
    }
    let decodedAccessToken = try values.decode(String.self, forKey: .accessToken)
    let decodedRefreshToken = try values.decode(String.self, forKey: .refreshToken)
    let decodedAccessTokenExpiresAt = try values.decode(Date.self, forKey: .accessTokenExpiresAt)
    let decodedScope = try values.decode([String].self, forKey: .scope)
    let decodedTokenType = try values.decode(String.self, forKey: .tokenType)
    guard
      let material = OAuthTokenMaterial(
        accessToken: decodedAccessToken,
        refreshToken: decodedRefreshToken,
        scope: decodedScope,
        tokenType: decodedTokenType
      )
    else {
      throw OAuthTokenRecordError.invalid
    }
    self.init(
      endpoint: decodedEndpoint,
      accessToken: material.accessToken,
      refreshToken: material.refreshToken,
      accessTokenExpiresAt: decodedAccessTokenExpiresAt,
      scope: material.scope,
      tokenType: material.tokenType
    )
  }

  func encode(to encoder: any Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(Self.currentVersion, forKey: .version)
    try values.encode(endpoint.absoluteString, forKey: .endpoint)
    try values.encode(accessToken, forKey: .accessToken)
    try values.encode(refreshToken, forKey: .refreshToken)
    try values.encode(accessTokenExpiresAt, forKey: .accessTokenExpiresAt)
    try values.encode(scope, forKey: .scope)
    try values.encode(tokenType, forKey: .tokenType)
  }
}

nonisolated struct OAuthAuthorizationStatus: Equatable, Sendable {
  let endpoint: NamaEndpoint
  let accessTokenExpiresAt: Date

  init(record: EndpointBoundOAuthTokenRecord) {
    endpoint = record.endpoint
    accessTokenExpiresAt = record.accessTokenExpiresAt
  }

  func matches(_ record: EndpointBoundOAuthTokenRecord) -> Bool {
    endpoint == record.endpoint && accessTokenExpiresAt == record.accessTokenExpiresAt
  }
}

nonisolated enum OAuthTokenRecordError: Error, Equatable {
  case invalid
  case unsupportedVersion
}

@MainActor
@Observable
final class OAuthAuthorizationSession {
  private(set) var authorization: OAuthAuthorizationStatus?
  private(set) var generation: UInt64 = 0
  private(set) var failureEndpoint: NamaEndpoint?
  private(set) var failure: OAuthAuthorizationFailure?
  @ObservationIgnored private var refreshOwner: UUID?
  @ObservationIgnored private var mutationOwner: UUID?

  func publish(_ record: EndpointBoundOAuthTokenRecord) {
    let status = OAuthAuthorizationStatus(record: record)
    guard authorization != status else {
      return
    }
    generation &+= 1
    authorization = status
    failureEndpoint = nil
    failure = nil
  }

  func fail(
    record: EndpointBoundOAuthTokenRecord,
    failure: OAuthAuthorizationFailure,
    expectedGeneration: UInt64? = nil
  ) {
    fail(
      status: OAuthAuthorizationStatus(record: record),
      failure: failure,
      expectedGeneration: expectedGeneration
    )
  }

  func fail(
    status: OAuthAuthorizationStatus,
    failure: OAuthAuthorizationFailure,
    expectedGeneration: UInt64? = nil
  ) {
    if let expectedGeneration {
      guard generation == expectedGeneration else {
        return
      }
    } else {
      guard authorization == nil else {
        return
      }
    }
    generation &+= 1
    authorization = nil
    failureEndpoint = status.endpoint
    self.failure = failure
  }

  func claimRefresh(owner: UUID, generation: UInt64) -> Bool {
    guard
      self.generation == generation,
      authorization != nil,
      refreshOwner == nil
    else {
      return false
    }
    refreshOwner = owner
    return true
  }

  func releaseRefresh(owner: UUID) {
    if refreshOwner == owner {
      refreshOwner = nil
    }
  }

  func claimMutation(owner: UUID) -> Bool {
    guard mutationOwner == nil else {
      return false
    }
    mutationOwner = owner
    return true
  }

  func releaseMutation(owner: UUID) {
    if mutationOwner == owner {
      mutationOwner = nil
    }
  }
}

nonisolated enum OAuthTokenStoreSnapshot: Equatable, Sendable {
  case missing
  case record(EndpointBoundOAuthTokenRecord)
  case damaged(Data)
  case unavailable
}

nonisolated protocol OAuthTokenStoring: Sendable {
  func load() async -> OAuthTokenStoreSnapshot
  func replace(with candidate: EndpointBoundOAuthTokenRecord) async throws
  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) async throws
  func remove(ifCurrent record: EndpointBoundOAuthTokenRecord) async throws
  func quarantine(_ data: Data) async throws
}

nonisolated enum OAuthAuthorizationClientError: Error, Equatable {
  case accessDenied
  case expired
  case invalidGrant
  case invalidResponse
  case network
}

nonisolated enum OAuthTokenPollResult: Equatable, Sendable {
  case pending
  case slowDown
  case denied
  case expired
  case authorized(OAuthTokenBundle)
}

nonisolated protocol OAuthAuthorizationClient: Sendable {
  func requestDeviceAuthorization(at endpoint: NamaEndpoint) async throws
    -> OAuthDeviceAuthorization
  func pollToken(at endpoint: NamaEndpoint, deviceCode: String) async throws -> OAuthTokenPollResult
  func refreshToken(at endpoint: NamaEndpoint, refreshToken: String) async throws
    -> OAuthTokenBundle
}

nonisolated protocol OAuthScopedAccessVerifying: Sendable {
  func verify(_ record: EndpointBoundOAuthTokenRecord) async throws
}

nonisolated enum OAuthAuthorizationFailure: Equatable, Sendable {
  case accessDenied
  case authorizationExpired
  case invalidResponse
  case networkUnavailable
  case tokenStorageUnavailable
}

nonisolated enum OAuthAuthorizationState: Equatable, Sendable {
  case idle
  case requesting(NamaEndpoint)
  case awaitingApproval(NamaEndpoint, userCode: String, verificationURI: URL)
  case authorized(OAuthAuthorizationStatus)
  case failed(NamaEndpoint, OAuthAuthorizationFailure)
}

extension NamaEndpoint {
  nonisolated func appending(path: String) -> URL {
    url.appending(path: path)
  }
}
