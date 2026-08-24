import SwiftUI

#if os(iOS)
  import UIKit
#endif

struct NamaDiscoveryContent: View {
  let feature: ConnectionFeature

  #if os(iOS)
    @Environment(\.openURL) private var openURL
  #endif

  @ViewBuilder
  var body: some View {
    switch feature.discoveryState {
    case .inactive:
      findButton

    case .scanning:
      if let title = feature.discoveryState.title {
        ProgressView {
          Text(title)
        }
      }

    case .empty:
      DiscoveryStatus(
        title: feature.discoveryState.title,
        message: feature.discoveryState.message
      )

    case .candidates(let candidates):
      VStack(alignment: .leading, spacing: DiscoveryLayout.candidateSpacing) {
        ForEach(candidates) { candidate in
          DiscoveryCandidateButton(feature: feature, candidate: candidate)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      #if os(tvOS)
        .focusSection()
      #endif

    case .permissionDenied:
      #if os(tvOS)
        DiscoveryStatus(
          title: NamaDiscoveryState.failed.title,
          message: NamaDiscoveryState.failed.message
        )
      #else
        DiscoveryStatus(
          title: feature.discoveryState.title,
          message: feature.discoveryState.message
        )
        #if os(iOS)
          Button("Open Settings") {
            guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else {
              return
            }
            openURL(settingsURL)
          }
        #elseif os(macOS)
          Text("System Settings → Privacy & Security → Local Network")
            .font(.callout)
            .foregroundStyle(.secondary)
        #endif
      #endif

    case .failed:
      DiscoveryStatus(
        title: feature.discoveryState.title,
        message: feature.discoveryState.message
      )
      findButton
    }
  }

  private var findButton: some View {
    Button("Find Nama on Local Network") {
      feature.activateDiscovery()
    }
  }
}

private enum DiscoveryLayout {
  static let candidateSpacing: CGFloat = 12
  static let statusSpacing: CGFloat = 6
  static let rowSpacing: CGFloat = 12
  static let labelSpacing: CGFloat = 4
}

private struct DiscoveryStatus: View {
  let title: LocalizedStringResource?
  let message: LocalizedStringResource?

  var body: some View {
    VStack(alignment: .leading, spacing: DiscoveryLayout.statusSpacing) {
      if let title {
        Text(title)
          .font(.headline)
      }
      if let message {
        Text(message)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct DiscoveryCandidateButton: View {
  let feature: ConnectionFeature
  let candidate: NamaDiscoveryCandidate

  var body: some View {
    Button {
      feature.select(candidate)
    } label: {
      HStack(spacing: DiscoveryLayout.rowSpacing) {
        VStack(alignment: .leading, spacing: DiscoveryLayout.labelSpacing) {
          Text(candidate.endpoint.absoluteString)
            .font(.body.monospaced())
            .foregroundStyle(.primary)
            .fixedSize(horizontal: false, vertical: true)
          Text(candidate.serviceNames.formatted(.list(type: .and)))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #if !os(tvOS)
          Image(systemName: "chevron.forward")
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
        #endif
      }
      .contentShape(.rect)
    }
    #if !os(tvOS)
      .buttonStyle(.plain)
    #endif
  }
}

#if DEBUG
  nonisolated private enum DiscoveryPreview {
    case inactive
    case scanning
    case empty
    case candidate
    case permissionDenied
    case failed
    case requiresHTTPS

    static let holdDurationSeconds = 3_600
    static let holdDuration = Duration.seconds(holdDurationSeconds)
    static let candidateEndpoint: NamaEndpoint = {
      do {
        return try NamaEndpoint("https://nama-living-room.example.com")
      } catch {
        preconditionFailure("Preview endpoint must be valid")
      }
    }()

    static let httpsRequiredEndpoint = HTTPSRequiredEndpoint(
      "http://nama-in-the-living-room-with-an-intentionally-long-hostname.example.com/reverse-proxy/"
    )
  }

  nonisolated private struct PreviewDiscovery: NamaDiscovering {
    let event: NamaDiscoveryEvent?

    func browse() -> AsyncStream<NamaDiscoveryEvent> {
      AsyncStream { continuation in
        if let event {
          continuation.yield(event)
        }
      }
    }
  }

  nonisolated private struct PreviewVerifier: ConnectionVerifying {
    func verify(_: NamaEndpoint) -> ConnectionVerificationResult {
      .ready
    }
  }

  private actor PreviewEndpointStore: VerifiedEndpointStoring {
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
  private func previewFeature(_ preview: DiscoveryPreview) -> ConnectionFeature {
    let event: NamaDiscoveryEvent?
    switch preview {
    case .inactive, .scanning, .empty, .requiresHTTPS:
      event = nil

    case .candidate:
      let candidateRecord = NamaDiscoveryRecord(
        endpoint: DiscoveryPreview.candidateEndpoint,
        serviceName:
          "Nama in the Living Room With an Intentionally Long and Untrusted Service Name"
      )
      event = .records([candidateRecord])

    case .permissionDenied:
      event = .failed(.permissionDenied)

    case .failed:
      event = .failed(.unavailable)
    }

    let feature = ConnectionFeature(
      verifier: PreviewVerifier(),
      discovery: PreviewDiscovery(event: event),
      endpointStore: PreviewEndpointStore()
    ) { _ in
      if preview == .empty {
        return
      }
      try await Task.sleep(for: DiscoveryPreview.holdDuration)
    }

    if preview == .requiresHTTPS {
      feature.setPreviewState(.requiresHTTPS(DiscoveryPreview.httpsRequiredEndpoint))
      return feature
    }

    feature.flowDidEnter()
    if preview != .inactive {
      feature.activateDiscovery()
    }
    return feature
  }

  #Preview("Discovery — Manual fallback") {
    ConnectionRootView(feature: previewFeature(.inactive))
  }

  #Preview("Discovery — Loading") {
    ConnectionRootView(feature: previewFeature(.scanning))
  }

  #Preview("Discovery — Empty") {
    ConnectionRootView(feature: previewFeature(.empty))
  }

  #Preview("Discovery — Candidate and long name") {
    ConnectionRootView(feature: previewFeature(.candidate))
  }

  #Preview("Discovery — Permission denied") {
    ConnectionRootView(feature: previewFeature(.permissionDenied))
  }

  #Preview("Discovery — Failure") {
    ConnectionRootView(feature: previewFeature(.failed))
  }

  #if os(tvOS)
    #Preview("HTTPS required — Apple TV") {
      ConnectionRootView(feature: previewFeature(.requiresHTTPS))
    }
  #else
    #Preview("HTTPS required — Form") {
      ConnectionRootView(feature: previewFeature(.requiresHTTPS))
    }
  #endif
#endif
