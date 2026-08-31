import Foundation
import Security
import Testing

@testable import Nama

@Suite("OAuth Keychain storage")
struct OAuthTokenStoreTests {
  @Test("new records use this-device-only non-synchronizing Keychain attributes")
  func keychainPolicy() async throws {
    let endpoint = try NamaEndpoint("https://nama.example.test")
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: endpoint,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let recorder = OAuthKeychainRecorder(updateStatus: errSecItemNotFound)
    let store = KeychainOAuthTokenStore(keychain: recorder.access)

    try await store.replace(with: record)

    let events = recorder.events
    #expect(events.map(\.name) == ["update", "add"])
    let attributes = try #require(events.last?.attributes)
    #expect(
      (attributes[kSecAttrAccessible] as? String)
        == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    )
    #expect(attributes[kSecAttrSynchronizable] as? Bool == false)
    #if os(macOS)
      #expect(attributes[kSecUseDataProtectionKeychain] as? Bool == true)
    #endif
    _ = try #require(attributes[kSecValueData] as? Data)
  }

  @Test("fractional expiry round-trips without changing authorization identity")
  func fractionalExpiryRoundTrip() async throws {
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: try NamaEndpoint("https://nama.example.test"),
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600.125),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let writerRecorder = OAuthKeychainRecorder(updateStatus: errSecItemNotFound)
    let writer = KeychainOAuthTokenStore(keychain: writerRecorder.access)
    try await writer.replace(with: record)
    let storedData = try #require(
      writerRecorder.events.last?.attributes[kSecValueData] as? Data
    )
    let readerRecorder = OAuthKeychainRecorder(
      updateStatus: errSecSuccess,
      loadResult: (errSecSuccess, storedData)
    )
    let reader = KeychainOAuthTokenStore(keychain: readerRecorder.access)

    #expect(await reader.load() == .record(record))
  }

  @Test("legacy ISO expiry records remain restorable")
  func legacyISOExpiryRecord() async throws {
    let record = EndpointBoundOAuthTokenRecord(
      endpoint: try NamaEndpoint("https://nama.example.test"),
      accessToken: "access-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Date(timeIntervalSince1970: 4_600),
      scope: OAuthConfiguration.consumerScopes,
      tokenType: "Bearer"
    )
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    let storedData = try encoder.encode(record)
    let recorder = OAuthKeychainRecorder(
      updateStatus: errSecSuccess,
      loadResult: (errSecSuccess, storedData)
    )
    let store = KeychainOAuthTokenStore(keychain: recorder.access)

    #expect(await store.load() == .record(record))
  }

  @Test("damaged bytes are durably quarantined before the active item is deleted")
  func quarantineOrdering() async throws {
    let damaged = Data("damaged-token-record".utf8)
    let recorder = OAuthKeychainRecorder(
      updateStatus: errSecSuccess,
      loadResult: (errSecSuccess, damaged)
    )
    let store = KeychainOAuthTokenStore(keychain: recorder.access) {
      "damaged-test-record"
    }

    try await store.quarantine(damaged)

    let events = recorder.events
    #expect(events.map(\.name) == ["load", "add", "delete"])
    #expect(events[1].attributes[kSecValueData] as? Data == damaged)
    #expect(events[1].attributes[kSecAttrSynchronizable] as? Bool == false)
    #if os(macOS)
      #expect(
        events.allSatisfy { $0.attributes[kSecUseDataProtectionKeychain] as? Bool == true }
      )
    #endif
  }
}

nonisolated private struct OAuthKeychainEvent: @unchecked Sendable {
  let name: String
  let attributes: [CFString: Any]
}

nonisolated private final class OAuthKeychainRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private let updateStatus: OSStatus
  private var recordedEvents: [OAuthKeychainEvent] = []
  private let loadResult: (OSStatus, Data?)

  init(
    updateStatus: OSStatus,
    loadResult: (OSStatus, Data?) = (errSecItemNotFound, nil)
  ) {
    self.updateStatus = updateStatus
    self.loadResult = loadResult
  }

  var events: [OAuthKeychainEvent] {
    lock.withLock { recordedEvents }
  }

  var access: OAuthKeychainAccess {
    OAuthKeychainAccess(
      load: { [weak self] attributes in
        self?.record("load", attributes: attributes)
        return self?.loadResult ?? (errSecNotAvailable, nil)
      },
      add: { [weak self] attributes in
        self?.record("add", attributes: attributes)
        return errSecSuccess
      },
      update: { [weak self] query, attributes in
        var combined = query
        for (key, value) in attributes {
          combined[key] = value
        }
        self?.record("update", attributes: combined)
        return self?.updateStatus ?? errSecNotAvailable
      },
      delete: { [weak self] query in
        self?.record("delete", attributes: query)
        return errSecSuccess
      }
    )
  }

  private func record(_ name: String, attributes: [CFString: Any]) {
    lock.withLock {
      recordedEvents.append(OAuthKeychainEvent(name: name, attributes: attributes))
    }
  }
}
