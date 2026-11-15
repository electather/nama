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

    static let candidateEndpoint = makeConnectionPreviewEndpoint(
      "https://nama-living-room.example.com"
    )
  }

  @MainActor
  private func previewFeature(_ preview: DiscoveryPreview) -> ConnectionFeature {
    let event: NamaDiscoveryEvent?
    switch preview {
    case .inactive, .scanning, .empty:
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

    let feature = makeConnectionPreviewFeature(
      discoveryEvent: event,
      completesDiscoveryScan: preview == .empty
    )
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
#endif
