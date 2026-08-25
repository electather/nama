import Foundation

@testable import Nama
actor RecordingOAuthSleep {
  private(set) var durations: [Duration] = []

  func callAsFunction(_ duration: Duration) async throws {
    durations.append(duration)
  }
}

actor TwoCycleOAuthSleep {
  private(set) var durations: [Duration] = []

  func callAsFunction(_ duration: Duration) async throws {
    durations.append(duration)
    if durations.count == 2 {
      throw CancellationError()
    }
  }
}

actor GatedRefreshOAuthSleep {
  private var started = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var continuation: CheckedContinuation<Void, Never>?
  private var callCount = 0

  func callAsFunction(_: Duration) async throws {
    callCount += 1
    if callCount > 1 {
      throw CancellationError()
    }
    started = true
    startWaiters.forEach { $0.resume() }
    startWaiters.removeAll()
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func waitUntilStarted() async {
    guard !started else {
      return
    }
    await withCheckedContinuation { continuation in
      startWaiters.append(continuation)
    }
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}

actor InMemoryOAuthAuthorizationClient: OAuthAuthorizationClient {
  private let deviceAuthorization: OAuthDeviceAuthorization?
  private var pollResults: [OAuthTokenPollResult]
  private let refreshResult: Result<OAuthTokenBundle, OAuthAuthorizationClientError>
  private(set) var requestedEndpoints: [NamaEndpoint] = []
  private(set) var polledDeviceCodes: [String] = []
  private(set) var refreshedTokens: [String] = []

  init(
    deviceAuthorization: OAuthDeviceAuthorization?,
    pollResults: [OAuthTokenPollResult],
    refreshResult: Result<OAuthTokenBundle, OAuthAuthorizationClientError> = .failure(.network)
  ) {
    self.deviceAuthorization = deviceAuthorization
    self.pollResults = pollResults
    self.refreshResult = refreshResult
  }

  func requestDeviceAuthorization(at endpoint: NamaEndpoint) async throws -> OAuthDeviceAuthorization {
    requestedEndpoints.append(endpoint)
    guard let deviceAuthorization else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return deviceAuthorization
  }

  func pollToken(
    at _: NamaEndpoint,
    deviceCode: String
  ) async throws -> OAuthTokenPollResult {
    polledDeviceCodes.append(deviceCode)
    guard !pollResults.isEmpty else {
      throw OAuthAuthorizationClientError.invalidResponse
    }
    return pollResults.removeFirst()
  }

  func refreshToken(
    at _: NamaEndpoint,
    refreshToken: String
  ) async throws -> OAuthTokenBundle {
    refreshedTokens.append(refreshToken)
    return try refreshResult.get()
  }
}

enum InMemoryOAuthTokenStoreError: Error {
  case unavailable
}

actor InMemoryOAuthTokenStore: OAuthTokenStoring {
  private var snapshot: OAuthTokenStoreSnapshot
  private let replaceError: InMemoryOAuthTokenStoreError?
  private(set) var record: EndpointBoundOAuthTokenRecord?
  private(set) var quarantined: [Data] = []

  init(
    snapshot: OAuthTokenStoreSnapshot,
    replaceError: InMemoryOAuthTokenStoreError? = nil
  ) {
    self.snapshot = snapshot
    self.replaceError = replaceError
    if case .record(let record) = snapshot {
      self.record = record
    }
  }

  func load() async -> OAuthTokenStoreSnapshot {
    snapshot
  }

  func replace(with candidate: EndpointBoundOAuthTokenRecord) async throws {
    if let replaceError {
      throw replaceError
    }
    record = candidate
    snapshot = .record(candidate)
  }
  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) async throws {
    guard record == candidate else {
      return
    }
    record = previous
    snapshot = previous.map(OAuthTokenStoreSnapshot.record) ?? .missing
  }

  func remove(ifCurrent expected: EndpointBoundOAuthTokenRecord) async throws {
    guard record == expected else {
      return
    }
    record = nil
    snapshot = .missing
  }

  func quarantine(_ data: Data) async throws {
    guard snapshot == .damaged(data) else {
      return
    }
    quarantined.append(data)
    record = nil
    snapshot = .missing
  }
}

actor SuspendingReplacementOAuthTokenStore: OAuthTokenStoring {
  private var snapshot: OAuthTokenStoreSnapshot
  private var replacementStarted = false
  private var replacementStartWaiters: [CheckedContinuation<Void, Never>] = []
  private var replacementContinuation: CheckedContinuation<Void, Never>?
  private(set) var record: EndpointBoundOAuthTokenRecord?

  init(record: EndpointBoundOAuthTokenRecord) {
    snapshot = .record(record)
    self.record = record
  }

  func load() async -> OAuthTokenStoreSnapshot {
    snapshot
  }

  func replace(with candidate: EndpointBoundOAuthTokenRecord) async throws {
    replacementStarted = true
    replacementStartWaiters.forEach { $0.resume() }
    replacementStartWaiters.removeAll()
    await withCheckedContinuation { continuation in
      replacementContinuation = continuation
    }
    record = candidate
    snapshot = .record(candidate)
  }

  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) async throws {
    guard record == candidate else {
      return
    }
    record = previous
    snapshot = previous.map(OAuthTokenStoreSnapshot.record) ?? .missing
  }

  func remove(ifCurrent expected: EndpointBoundOAuthTokenRecord) async throws {
    guard record == expected else {
      return
    }
    record = nil
    snapshot = .missing
  }

  func quarantine(_ data: Data) async throws {
    guard snapshot == .damaged(data) else {
      return
    }
    record = nil
    snapshot = .missing
  }

  func setRecord(_ record: EndpointBoundOAuthTokenRecord) {
    self.record = record
    snapshot = .record(record)
  }

  func waitUntilReplacementStarts() async {
    guard !replacementStarted else {
      return
    }
    await withCheckedContinuation { continuation in
      replacementStartWaiters.append(continuation)
    }
  }

  func resumeReplacement() {
    replacementContinuation?.resume()
    replacementContinuation = nil
  }
}

actor InMemoryOAuthScopedAccessVerifier: OAuthScopedAccessVerifying {
  private let error: OAuthAuthorizationClientError?
  private(set) var records: [EndpointBoundOAuthTokenRecord] = []

  init(error: OAuthAuthorizationClientError? = nil) {
    self.error = error
  }

  func verify(_ record: EndpointBoundOAuthTokenRecord) async throws {
    records.append(record)
    if let error {
      throw error
    }
  }
}

actor GatedOAuthScopedAccessVerifier: OAuthScopedAccessVerifying {
  private var started = false
  private var startWaiters: [CheckedContinuation<Void, Never>] = []
  private var continuation: CheckedContinuation<Void, Never>?

  func verify(_: EndpointBoundOAuthTokenRecord) async throws {
    started = true
    startWaiters.forEach { $0.resume() }
    startWaiters.removeAll()
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func waitUntilStarted() async {
    guard !started else {
      return
    }
    await withCheckedContinuation { continuation in
      startWaiters.append(continuation)
    }
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}

actor SequenceOAuthScopedAccessVerifier: OAuthScopedAccessVerifying {
  private var errors: [OAuthAuthorizationClientError?]
  private(set) var records: [EndpointBoundOAuthTokenRecord] = []

  init(errors: [OAuthAuthorizationClientError?]) {
    self.errors = errors
  }

  func verify(_ record: EndpointBoundOAuthTokenRecord) async throws {
    records.append(record)
    guard !errors.isEmpty else {
      return
    }
    if let error = errors.removeFirst() {
      throw error
    }
  }
}
