import Foundation

nonisolated enum ConnectionAction: Hashable, Sendable {
  case connect
  case cancel
  case retry
  case changeEndpoint
}

nonisolated extension EndpointValidationError {
  var message: LocalizedStringResource {
    "Enter a valid HTTP or HTTPS server address."
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

nonisolated extension ConnectionState {
  var actions: [ConnectionAction] {
    switch self {
    case .editing:
      [.connect]

    case .verifying:
      [.connect, .cancel]

    case .ready:
      [.changeEndpoint]

    case .setupRequired, .failed:
      [.retry, .changeEndpoint]
    }
  }
}
