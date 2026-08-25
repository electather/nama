import Foundation
import Security

nonisolated struct OAuthKeychainAccess: @unchecked Sendable {
  let load: ([CFString: Any]) -> (OSStatus, Data?)
  let add: ([CFString: Any]) -> OSStatus
  let update: ([CFString: Any], [CFString: Any]) -> OSStatus
  let delete: ([CFString: Any]) -> OSStatus

  static let system = OAuthKeychainAccess(
    load: { query in
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      return (status, result as? Data)
    },
    add: { attributes in
      SecItemAdd(attributes as CFDictionary, nil)
    },
    update: { query, attributes in
      SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    },
    delete: { query in
      SecItemDelete(query as CFDictionary)
    }
  )
}

actor KeychainOAuthTokenStore: OAuthTokenStoring {
  private let keychain: OAuthKeychainAccess
  private let quarantineAccount: @Sendable () -> String

  private static let service = "com.electather.nama.oauth-token"
  private static let activeAccount = "active-endpoint-bound-token"
  private static let quarantineService = "com.electather.nama.oauth-token.quarantine"

  init(
    keychain: OAuthKeychainAccess = .system,
    quarantineAccount: @escaping @Sendable () -> String = {
      "damaged-\(UUID().uuidString.lowercased())"
    }
  ) {
    self.keychain = keychain
    self.quarantineAccount = quarantineAccount
  }

  func load() async -> OAuthTokenStoreSnapshot {
    loadSnapshot()
  }

  func replace(with candidate: EndpointBoundOAuthTokenRecord) async throws {
    guard !Task.isCancelled else {
      throw CancellationError()
    }
    try replaceRecord(with: candidate)
  }

  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) async throws {
    guard loadSnapshot() == .record(candidate) else {
      return
    }
    if let previous {
      try replaceRecord(with: previous)
    } else {
      try removeRecord()
    }
  }

  func remove(ifCurrent record: EndpointBoundOAuthTokenRecord) async throws {
    guard !Task.isCancelled, loadSnapshot() == .record(record) else {
      return
    }
    try removeRecord()
  }

  func quarantine(_ data: Data) async throws {
    guard loadSnapshot() == .damaged(data) else {
      return
    }
    let attributes: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.quarantineService,
      kSecAttrAccount: quarantineAccount(),
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAttrSynchronizable: false,
      kSecValueData: data,
    ]
    guard keychain.add(attributes) == errSecSuccess else {
      throw OAuthTokenStoreError.unavailable
    }
    try removeRecord()
  }

  private func loadSnapshot() -> OAuthTokenStoreSnapshot {
    let (status, data) = keychain.load(Self.activeQuery(returnData: true))
    if status == errSecItemNotFound {
      return .missing
    }
    guard status == errSecSuccess, let data else {
      return .unavailable
    }
    do {
      let decoder = JSONDecoder()
      decoder.dateDecodingStrategy = .iso8601
      return .record(try decoder.decode(EndpointBoundOAuthTokenRecord.self, from: data))
    } catch {
      return .damaged(data)
    }
  }

  private func replaceRecord(with candidate: EndpointBoundOAuthTokenRecord) throws {
    let data: Data
    do {
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .iso8601
      data = try encoder.encode(candidate)
    } catch {
      throw OAuthTokenStoreError.encodingFailed
    }
    let valueAttributes = Self.valueAttributes(data)
    let updateStatus = keychain.update(Self.activeQuery(returnData: false), valueAttributes)
    if updateStatus == errSecSuccess {
      return
    }
    guard updateStatus == errSecItemNotFound else {
      throw OAuthTokenStoreError.unavailable
    }
    var addAttributes = Self.activeQuery(returnData: false)
    valueAttributes.forEach { key, value in
      addAttributes[key] = value
    }
    guard keychain.add(addAttributes) == errSecSuccess else {
      throw OAuthTokenStoreError.unavailable
    }
  }

  private func removeRecord() throws {
    let status = keychain.delete(Self.activeQuery(returnData: false))
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw OAuthTokenStoreError.unavailable
    }
  }

  private static func activeQuery(returnData: Bool) -> [CFString: Any] {
    var query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: service,
      kSecAttrAccount: activeAccount,
      kSecAttrSynchronizable: false,
    ]
    if returnData {
      query[kSecReturnData] = true
      query[kSecMatchLimit] = kSecMatchLimitOne
    }
    return query
  }

  private static func valueAttributes(_ data: Data) -> [CFString: Any] {
    [
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAttrSynchronizable: false,
      kSecValueData: data,
    ]
  }
}

nonisolated enum OAuthTokenStoreError: Error, Equatable {
  case encodingFailed
  case unavailable
}
