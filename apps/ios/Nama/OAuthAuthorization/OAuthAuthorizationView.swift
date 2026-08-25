import SwiftUI

private enum OAuthAuthorizationTVLayout {
  static let contentSpacing: CGFloat = 32
  static let contentPadding: CGFloat = 64
  static let maximumContentWidth: CGFloat = 1_000
}

struct OAuthAuthorizationView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var retryGeneration = 0
  let feature: OAuthAuthorizationFeature
  let endpoint: NamaEndpoint
  let changeEndpoint: @MainActor () async -> Void

  var body: some View {
    platformBody
      .task(
        id: OAuthAuthorizationTaskID(
          endpoint: endpoint,
          retryGeneration: retryGeneration,
          isActive: scenePhase == .active
        )
      ) {
        guard scenePhase == .active else {
          return
        }
        await feature.run(endpoint)
      }
  }

  #if os(tvOS)
    private var platformBody: some View {
      VStack(alignment: .leading, spacing: OAuthAuthorizationTVLayout.contentSpacing) {
        content
        HStack {
          recoveryActions
        }
      }
      .padding(OAuthAuthorizationTVLayout.contentPadding)
      .frame(
        maxWidth: OAuthAuthorizationTVLayout.maximumContentWidth,
        maxHeight: .infinity,
        alignment: .leading
      )
    }
  #else
    private var platformBody: some View {
      NavigationStack {
        Form {
          content
          Section {
            recoveryActions
          }
        }
        .formStyle(.grouped)
        .navigationTitle("Authorize Nama")
      }
    }
  #endif

  @ViewBuilder
  private var content: some View {
    switch feature.state {
    case .idle, .requesting:
      Section {
        ProgressView("Requesting device authorization…")
      } footer: {
        EndpointText(endpoint: endpoint)
      }

    case .awaitingApproval(let requestedEndpoint, let userCode, _):
      Section {
        Text(verbatim: userCode)
          .font(.system(.largeTitle, design: .monospaced, weight: .semibold))
          .modifier(OAuthTextSelectionModifier())
          .accessibilityLabel("Device authorization user code")
          .accessibilityValue(userCode)
        Text("Run this command from a terminal where you are already signed in:")
        Text(verbatim: "nama auth approve-device \(userCode)")
          .font(.system(.body, design: .monospaced))
          .modifier(OAuthTextSelectionModifier())
        EndpointText(endpoint: requestedEndpoint)
      } header: {
        Text("Approve on the CLI")
      } footer: {
        Text(
          "Nama will continue automatically after approval. No browser or password is required on this device."
        )
      }

    case .authorized(let status):
      Section {
        Label("Nama is authorized", systemImage: "checkmark.circle.fill")
          .font(.headline)
          .foregroundStyle(.green)
        EndpointText(endpoint: status.endpoint)
      } footer: {
        Text("This device now has scoped consumer access. Administrator access was not granted.")
      }

    case .failed(let failedEndpoint, let failure):
      Section {
        Label(authorizationTitle(for: failure), systemImage: "exclamationmark.triangle")
          .font(.headline)
        Text(authorizationMessage(for: failure))
        EndpointText(endpoint: failedEndpoint)
      }
    }
  }

  @ViewBuilder
  private var recoveryActions: some View {
    if case .failed = feature.state {
      Button("Try Again") {
        retryGeneration &+= 1
      }
      .buttonStyle(.borderedProminent)
    }
    Button("Change Endpoint") {
      Task {
        await changeEndpoint()
      }
    }
  }
}

private struct OAuthAuthorizationTaskID: Hashable {
  let endpoint: NamaEndpoint
  let retryGeneration: Int
  let isActive: Bool
}

private struct EndpointText: View {
  let endpoint: NamaEndpoint

  var body: some View {
    Text(verbatim: endpoint.absoluteString)
      .font(.footnote.monospaced())
      .foregroundStyle(.secondary)
      .modifier(OAuthTextSelectionModifier())
      .accessibilityLabel("Nama endpoint")
      .accessibilityValue(endpoint.absoluteString)
  }
}

private struct OAuthTextSelectionModifier: ViewModifier {
  func body(content: Content) -> some View {
    #if os(tvOS)
      content
    #else
      content.textSelection(.enabled)
    #endif
  }
}

private func authorizationTitle(for failure: OAuthAuthorizationFailure) -> LocalizedStringKey {
  switch failure {
  case .accessDenied:
    "Authorization denied"

  case .authorizationExpired:
    "Authorization expired"

  case .invalidResponse:
    "Nama could not authorize this device"

  case .networkUnavailable:
    "Nama is unavailable"

  case .tokenStorageUnavailable:
    "Authorization could not be saved"
  }
}

private func authorizationMessage(for failure: OAuthAuthorizationFailure) -> LocalizedStringKey {
  switch failure {
  case .accessDenied:
    "Start again when you are ready to approve this device."

  case .authorizationExpired:
    "The displayed user code is no longer valid. Request a new one."

  case .invalidResponse:
    "The authorization response was not compatible with this version of Nama."

  case .networkUnavailable:
    "Check that the Nama endpoint is reachable, then try again."

  case .tokenStorageUnavailable:
    "The existing authorization was preserved. Unlock this device and try again."
  }
}
