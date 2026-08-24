import Foundation

nonisolated enum ConnectionAction: Hashable, Sendable {
  case connect
  case cancel
  case continueWithoutHTTPS
  case retry
  case changeEndpoint
}

nonisolated enum TelevisionConnectionFocus: Equatable, Sendable {
  case address
  case action(ConnectionAction)
}

nonisolated extension EndpointValidationError {
  var message: LocalizedStringResource {
    switch self {
    case .invalid:
      "Enter a valid HTTP or HTTPS Nama endpoint."

    case .requiresHTTPS:
      "This Nama endpoint requires HTTPS."
    }
  }
}

nonisolated enum SavedEndpointHTTPSRequiredCopy {
  static var title: LocalizedStringResource {
    "HTTPS required"
  }

  static var message: LocalizedStringResource {
    "This saved Nama endpoint can no longer be contacted over HTTP. Change the endpoint to use HTTPS."
  }
}

nonisolated enum LocalHTTPConfirmationCopy {
  static var title: LocalizedStringResource {
    "Connect without HTTPS?"
  }

  static var message: LocalizedStringResource {
    "Traffic to this Nama endpoint won’t be encrypted. Continue only if you trust this endpoint and network."
  }
}

nonisolated enum LocalHTTPWarningCopy {
  static let systemImage = "exclamationmark.triangle.fill"

  static var message: LocalizedStringResource {
    "HTTP connection — traffic is not encrypted."
  }

  static var accessibilityLabel: LocalizedStringResource {
    message
  }
}

nonisolated extension VerificationFailure {
  var message: LocalizedStringResource {
    switch self {
    case .namaUnavailable:
      "Nama is temporarily unavailable. Try again."

    case .cannotConnect:
      "Couldn’t connect to this address. Check the address and network connection, then try again."

    case .incompatible:
      "This address did not respond as a compatible Nama server."
    }
  }
}

nonisolated extension NamaDiscoveryState {
  var title: LocalizedStringResource? {
    switch self {
    case .inactive, .candidates:
      nil

    case .scanning:
      "Looking for Nama servers…"

    case .empty:
      "No Nama servers found"

    case .permissionDenied:
      "Local Network Access Is Off"

    case .failed:
      "Couldn’t search for Nama servers"
    }
  }

  var message: LocalizedStringResource? {
    switch self {
    case .inactive, .scanning, .candidates:
      nil

    case .empty:
      "Make sure Nama is running on this network, or enter its address."

    case .permissionDenied:
      "Enable Local Network access in Settings to find nearby Nama servers, or enter an address manually."

    case .failed:
      "Try again, or enter the Nama address manually."
    }
  }
}

nonisolated extension ConnectionState {
  var actions: [ConnectionAction] {
    switch self {
    case .editing:
      [.connect]

    case .confirmingHTTP:
      [.cancel, .continueWithoutHTTPS]

    case .checkingHTTPAcknowledgement, .verifying:
      [.connect, .cancel, .changeEndpoint]

    case .ready, .requiresHTTPS:
      [.changeEndpoint]

    case .setupRequired, .failed:
      [.retry, .changeEndpoint]

    case .pausedHTTPRestoration:
      [.continueWithoutHTTPS, .changeEndpoint]
    }
  }

  var televisionFocus: TelevisionConnectionFocus {
    switch self {
    case .editing, .checkingHTTPAcknowledgement, .verifying:
      .address

    case .confirmingHTTP:
      .action(.cancel)

    case .ready, .requiresHTTPS:
      .action(.changeEndpoint)

    case .setupRequired, .failed:
      .action(.retry)

    case .pausedHTTPRestoration:
      .action(.continueWithoutHTTPS)
    }
  }

  var showsUnencryptedHTTPWarning: Bool {
    let endpoint: NamaEndpoint
    switch self {
    case .checkingHTTPAcknowledgement(let value), .confirmingHTTP(let value, _),
      .verifying(let value), .ready(let value), .setupRequired(let value),
      .failed(let value, _), .pausedHTTPRestoration(let value):
      endpoint = value

    case .editing, .requiresHTTPS:
      return false
    }
    return endpoint.usesUnencryptedHTTP
  }
}
