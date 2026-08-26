import Foundation

#if DEBUG
  import SwiftUI
#endif

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
#if DEBUG
  nonisolated func makeConnectionPreviewEndpoint(_ absoluteString: String) -> NamaEndpoint {
    do {
      return try NamaEndpoint(absoluteString)
    } catch {
      preconditionFailure("Preview endpoint must be valid")
    }
  }

  nonisolated private enum ConnectionStatePreview {
    case confirmation
    case readyHTTP
    case failedHTTP
    case requiresHTTPS

    static let holdDurationSeconds = 3_600
    static let holdDuration = Duration.seconds(holdDurationSeconds)
    static let localHTTPEndpoint = makeConnectionPreviewEndpoint(
      "http://nama.local/a/very/long/reverse/proxy/path/that/must/remain/visible/"
    )

    static let httpsRequiredEndpoint = HTTPSRequiredEndpoint(
      "http://nama-in-the-living-room-with-an-intentionally-long-hostname.example.com/reverse-proxy/"
    )
  }

  nonisolated private struct ConnectionPreviewDiscovery: NamaDiscovering {
    let event: NamaDiscoveryEvent?

    func browse() -> AsyncStream<NamaDiscoveryEvent> {
      AsyncStream { continuation in
        if let event {
          continuation.yield(event)
        }
      }
    }
  }

  nonisolated private struct ConnectionPreviewVerifier: ConnectionVerifying {
    func verify(_: NamaEndpoint) -> ConnectionVerificationResult {
      .ready
    }
  }

  private actor ConnectionPreviewEndpointStore: VerifiedEndpointStoring {
    private var endpoint: NamaEndpoint?
    private var generation: UInt64 = 0

    func snapshot() -> VerifiedEndpointStoreSnapshot {
      VerifiedEndpointStoreSnapshot(
        endpoint: endpoint.map(RestoredNamaEndpoint.eligible),
        generation: generation
      )
    }

    func save(
      _ endpoint: NamaEndpoint,
      ifUnchangedSince snapshot: VerifiedEndpointStoreSnapshot
    ) -> Bool {
      guard snapshot.generation == generation else {
        return false
      }
      self.endpoint = endpoint
      return true
    }

    func isCurrent(_ snapshot: VerifiedEndpointStoreSnapshot) -> Bool {
      snapshot.generation == generation
    }

    func clear() {
      generation &+= 1
      endpoint = nil
    }
  }

  @MainActor
  func makeConnectionPreviewFeature(
    discoveryEvent: NamaDiscoveryEvent? = nil,
    completesDiscoveryScan: Bool = false
  ) -> ConnectionFeature {
    ConnectionFeature(
      verifier: ConnectionPreviewVerifier(),
      discovery: ConnectionPreviewDiscovery(event: discoveryEvent),
      endpointStore: ConnectionPreviewEndpointStore()
    ) { _ in
      if completesDiscoveryScan {
        return
      }
      try await Task.sleep(for: ConnectionStatePreview.holdDuration)
    }
  }

  @MainActor
  private func connectionStatePreviewFeature(
    _ preview: ConnectionStatePreview
  ) -> ConnectionFeature {
    let feature = makeConnectionPreviewFeature()
    switch preview {
    case .confirmation:
      feature.setPreviewState(
        .confirmingHTTP(ConnectionStatePreview.localHTTPEndpoint, .entry)
      )

    case .readyHTTP:
      feature.setPreviewState(.ready(ConnectionStatePreview.localHTTPEndpoint))

    case .failedHTTP:
      feature.setPreviewState(
        .failed(ConnectionStatePreview.localHTTPEndpoint, .cannotConnect)
      )

    case .requiresHTTPS:
      feature.setPreviewState(
        .requiresHTTPS(ConnectionStatePreview.httpsRequiredEndpoint)
      )
    }
    return feature
  }

  #Preview("Local HTTP — Confirmation and long endpoint") {
    ConnectionRootView(feature: connectionStatePreviewFeature(.confirmation))
  }

  #Preview("Local HTTP — Ready warning") {
    ConnectionRootView(feature: connectionStatePreviewFeature(.readyHTTP))
  }

  #Preview("Local HTTP — Failure warning") {
    ConnectionRootView(feature: connectionStatePreviewFeature(.failedHTTP))
  }

  #if os(tvOS)
    #Preview("HTTPS required — Apple TV") {
      ConnectionRootView(feature: connectionStatePreviewFeature(.requiresHTTPS))
    }
  #else
    #Preview("HTTPS required — Form") {
      ConnectionRootView(feature: connectionStatePreviewFeature(.requiresHTTPS))
    }
  #endif
#endif
