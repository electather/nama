import Foundation

nonisolated enum RestoredNamaEndpoint: Equatable, Sendable {
  case eligible(NamaEndpoint)
  case requiresHTTPS(HTTPSRequiredEndpoint)
}

nonisolated struct VerifiedEndpointStoreSnapshot: Sendable {
  let endpoint: RestoredNamaEndpoint?
  let acknowledgedLocalHTTPEndpoint: NamaEndpoint?
  let generation: UInt64

  init(
    endpoint: RestoredNamaEndpoint?,
    generation: UInt64,
    acknowledgedLocalHTTPEndpoint: NamaEndpoint? = nil
  ) {
    self.endpoint = endpoint
    self.generation = generation
    self.acknowledgedLocalHTTPEndpoint = acknowledgedLocalHTTPEndpoint
  }

  func acknowledgesLocalHTTP(_ endpoint: NamaEndpoint) -> Bool {
    endpoint.usesUnencryptedHTTP
      && self.endpoint == .eligible(endpoint)
      && acknowledgedLocalHTTPEndpoint == endpoint
  }
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
  private static let acknowledgedLocalHTTPEndpointKey =
    "acknowledgedLocalHTTPNamaEndpoint"

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
    let acknowledgement =
      defaults
      .string(forKey: Self.acknowledgedLocalHTTPEndpointKey)
      .flatMap(Self.restoredLocalHTTPAcknowledgement)
    return VerifiedEndpointStoreSnapshot(
      endpoint: endpoint,
      generation: generation,
      acknowledgedLocalHTTPEndpoint: acknowledgement
    )
  }

  func save(
    _ endpoint: NamaEndpoint,
    ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
  ) -> Bool {
    guard snapshot.generation == generation else {
      return false
    }
    defaults.set(endpoint.absoluteString, forKey: Self.endpointKey)
    if endpoint.usesUnencryptedHTTP {
      defaults.set(
        endpoint.absoluteString,
        forKey: Self.acknowledgedLocalHTTPEndpointKey
      )
    } else {
      defaults.removeObject(forKey: Self.acknowledgedLocalHTTPEndpointKey)
    }
    return true
  }

  func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) -> Bool {
    snapshot.generation == generation
  }

  func clear() {
    generation &+= 1
    defaults.removeObject(forKey: Self.endpointKey)
    defaults.removeObject(forKey: Self.acknowledgedLocalHTTPEndpointKey)
  }

  private static func restoredEndpoint(_ value: String) -> RestoredNamaEndpoint? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    do {
      return .eligible(try NamaEndpoint(trimmed))
    } catch let error as EndpointValidationError where error == .requiresHTTPS {
      return .requiresHTTPS(HTTPSRequiredEndpoint(trimmed))
    } catch {
      return nil
    }
  }

  private static func restoredLocalHTTPAcknowledgement(
    _ value: String
  ) -> NamaEndpoint? {
    guard let endpoint = try? NamaEndpoint(value),
      endpoint.usesUnencryptedHTTP,
      value == endpoint.absoluteString
    else {
      return nil
    }
    return endpoint
  }
}
