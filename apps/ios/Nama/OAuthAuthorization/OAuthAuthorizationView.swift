import SwiftUI

private enum OAuthAuthorizationTVLayout {
  static let contentSpacing: CGFloat = 32
  static let contentPadding: CGFloat = 64
  static let maximumContentWidth: CGFloat = 1_000
}

struct OAuthAuthorizationView: View {
  let feature: OAuthAuthorizationFeature
  let endpoint: NamaEndpoint
  let changeEndpoint: @MainActor () async -> Void
  let retry: @MainActor () -> Void

  var body: some View {
    platformBody
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

    case .authorized:
      Section {
        ProgressView("Preparing Home…")
      } footer: {
        EndpointText(endpoint: endpoint)
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
      Button("Try Again", action: retry)
        .buttonStyle(.borderedProminent)
    }
    Button("Change Endpoint") {
      Task {
        await changeEndpoint()
      }
    }
  }
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

  case .authorizationResetUnavailable:
    "Authorization could not be reset"

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

  case .authorizationResetUnavailable:
    "The rejected authorization is not active. Unlock this device, then try again."

  case .invalidResponse:
    "The authorization response was not compatible with this version of Nama."

  case .networkUnavailable:
    "Check that the Nama endpoint is reachable, then try again."

  case .tokenStorageUnavailable:
    "The existing authorization was preserved. Unlock this device and try again."
  }
}
