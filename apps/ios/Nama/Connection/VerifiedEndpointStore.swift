import Foundation

nonisolated struct VerifiedEndpointStoreSnapshot: Sendable {
  let endpoint: NamaEndpoint?
  let generation: UInt64
}

nonisolated protocol VerifiedEndpointStoring: Sendable {
  func snapshot() async -> VerifiedEndpointStoreSnapshot
  func save(
    _ endpoint: NamaEndpoint,
    ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
  ) async -> Bool
  func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) async -> Bool
  func clear() async
}

actor UserDefaultsVerifiedEndpointStore: VerifiedEndpointStoring {
  private static let endpointKey = "verifiedNamaEndpoint"

  private let defaults: UserDefaults
  private var generation: UInt64 = 0

  init(suiteName: String? = nil) {
    if let suiteName {
      guard let suiteDefaults = UserDefaults(suiteName: suiteName) else {
        preconditionFailure("UserDefaults suite must be available")
      }
      defaults = suiteDefaults
    } else {
      defaults = .standard
    }
  }

  func snapshot() -> VerifiedEndpointStoreSnapshot {
    let endpoint = defaults.string(forKey: Self.endpointKey).flatMap { value in
      try? NamaEndpoint(value)
    }
    return VerifiedEndpointStoreSnapshot(endpoint: endpoint, generation: generation)
  }

  func save(
    _ endpoint: NamaEndpoint,
    ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
  ) -> Bool {
    guard snapshot.generation == generation else {
      return false
    }
    defaults.set(endpoint.absoluteString, forKey: Self.endpointKey)
    return true
  }

  func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) -> Bool {
    snapshot.generation == generation
  }

  func clear() {
    generation &+= 1
    defaults.removeObject(forKey: Self.endpointKey)
  }
}
