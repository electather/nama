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
    let storedData = try #require(attributes[kSecValueData] as? Data)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    #expect(try decoder.decode(EndpointBoundOAuthTokenRecord.self, from: storedData) == record)
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
    #expect(events.map(\.name) == ["add", "delete"])
    #expect(events.first?.attributes[kSecValueData] as? Data == damaged)
    #expect(events.first?.attributes[kSecAttrSynchronizable] as? Bool == false)
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
      load: { [weak self] _ in self?.loadResult ?? (errSecNotAvailable, nil) },
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
