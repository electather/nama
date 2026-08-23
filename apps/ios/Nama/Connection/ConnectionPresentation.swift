import Foundation

nonisolated enum ConnectionAction: Hashable, Sendable {
  case connect
  case cancel
  case retry
  case changeEndpoint
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

    case .verifying:
      [.connect, .cancel, .changeEndpoint]

    case .ready, .requiresHTTPS:
      [.changeEndpoint]

    case .setupRequired, .failed:
      [.retry, .changeEndpoint]
    }
  }
}
