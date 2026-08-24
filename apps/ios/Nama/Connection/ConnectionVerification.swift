nonisolated enum VerificationFailure: Equatable, Sendable {
  case namaUnavailable
  case cannotConnect
  case incompatible
}

nonisolated enum ConnectionVerificationResult: Equatable, Sendable {
  case ready
  case setupRequired
  case failure(VerificationFailure)
  case cancelled
}

nonisolated protocol ConnectionVerifying: Sendable {
  func verify(_ endpoint: NamaEndpoint) async -> ConnectionVerificationResult
}

nonisolated enum RestoredEndpointResolution: Sendable {
  case confirmation(NamaEndpoint, VerifiedEndpointStoreSnapshot)
  case verification(NamaEndpoint, ConnectionVerificationResult)
  case requiresHTTPS(HTTPSRequiredEndpoint)
}

nonisolated func verifyEndpoint(
  _ endpoint: NamaEndpoint,
  from snapshot: VerifiedEndpointStoreSnapshot,
  using verifier: any ConnectionVerifying,
  endpointStore: any VerifiedEndpointStoring
) async -> ConnectionVerificationResult? {
  let result = await verifier.verify(endpoint)
  guard !Task.isCancelled else {
    return nil
  }

  switch result {
  case .ready, .setupRequired:
    guard await endpointStore.save(endpoint, ifUnchangedSince: snapshot) else {
      return nil
    }
    return result

  case .failure:
    guard await endpointStore.isCurrent(snapshot) else {
      return nil
    }
    return result

  case .cancelled:
    return result
  }
}

nonisolated func resolveRestoredEndpoint(
  _ restoredEndpoint: RestoredNamaEndpoint,
  from snapshot: VerifiedEndpointStoreSnapshot,
  using verifier: any ConnectionVerifying,
  endpointStore: any VerifiedEndpointStoring
) async -> RestoredEndpointResolution? {
  switch restoredEndpoint {
  case .eligible(let endpoint):
    if endpoint.usesUnencryptedHTTP {
      guard await endpointStore.isCurrent(snapshot) else {
        return nil
      }
      return .confirmation(endpoint, snapshot)
    }
    guard
      let result = await verifyEndpoint(
        endpoint,
        from: snapshot,
        using: verifier,
        endpointStore: endpointStore
      )
    else {
      return nil
    }
    return .verification(endpoint, result)

  case .requiresHTTPS(let endpoint):
    guard await endpointStore.isCurrent(snapshot) else {
      return nil
    }
    return .requiresHTTPS(endpoint)
  }
}
