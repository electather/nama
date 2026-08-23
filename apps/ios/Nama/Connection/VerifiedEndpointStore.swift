import Foundation

nonisolated enum RestoredNamaEndpoint: Equatable, Sendable {
  case eligible(NamaEndpoint)
  case requiresHTTPS(String)
}

nonisolated struct VerifiedEndpointStoreSnapshot: Sendable {
  let endpoint: RestoredNamaEndpoint?
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
    let endpoint = defaults.string(forKey: Self.endpointKey).flatMap(Self.restoredEndpoint)
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

  private static func restoredEndpoint(_ value: String) -> RestoredNamaEndpoint? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      return .eligible(try NamaEndpoint(trimmed))
    } catch let error as EndpointValidationError where error == .requiresHTTPS {
      return .requiresHTTPS(trimmed)
    } catch {
      return nil
    }
  }
}
