nonisolated enum HTTPConfirmationContext: Equatable, Sendable {
  case entry
  case restoration
}

nonisolated enum ConnectionState: Equatable, Sendable {
  case editing(validationError: EndpointValidationError?)
  case checkingHTTPAcknowledgement(NamaEndpoint)
  case confirmingHTTP(NamaEndpoint, HTTPConfirmationContext)
  case verifying(NamaEndpoint)
  case ready(NamaEndpoint)
  case setupRequired(NamaEndpoint)
  case failed(NamaEndpoint, VerificationFailure)
  case pausedHTTPRestoration(NamaEndpoint)
  case requiresHTTPS(HTTPSRequiredEndpoint)
}
