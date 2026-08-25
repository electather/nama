import SwiftUI

struct OAuthAuthorizationView: View {
  @State private var retryGeneration = 0
  let feature: OAuthAuthorizationFeature
  let endpoint: NamaEndpoint
  let changeEndpoint: @MainActor () async -> Void

  var body: some View {
    #if os(tvOS)
      televisionBody
    #else
      formBody
    #endif
  }

  #if os(tvOS)
    private var televisionBody: some View {
      VStack(alignment: .leading, spacing: 32) {
        content
        HStack {
          recoveryActions
        }
      }
      .padding(64)
      .frame(maxWidth: 1_000, maxHeight: .infinity, alignment: .leading)
      .task(
        id: OAuthAuthorizationTaskID(
          endpoint: endpoint,
          retryGeneration: retryGeneration
        )
      ) {
        await feature.run(endpoint)
      }
    }
  #else
    private var formBody: some View {
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
      .task(
        id: OAuthAuthorizationTaskID(
          endpoint: endpoint,
          retryGeneration: retryGeneration
        )
      ) {
        await feature.run(endpoint)
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
      Section("Approve on the CLI") {
        Text(verbatim: userCode)
          .font(.system(.largeTitle, design: .monospaced, weight: .semibold))
          .textSelection(.enabled)
          .accessibilityLabel("Device authorization user code")
          .accessibilityValue(userCode)
        Text("Run this command from a terminal where you are already signed in:")
        Text(verbatim: "nama auth approve-device \(userCode)")
          .font(.system(.body, design: .monospaced))
          .textSelection(.enabled)
        EndpointText(endpoint: requestedEndpoint)
      } footer: {
        Text("Nama will continue automatically after approval. No browser or password is required on this device.")
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
        Label(failure.title, systemImage: "exclamationmark.triangle")
          .font(.headline)
        Text(failure.message)
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
}

private struct EndpointText: View {
  let endpoint: NamaEndpoint

  var body: some View {
    Text(verbatim: endpoint.absoluteString)
      .font(.footnote.monospaced())
      .foregroundStyle(.secondary)
      .textSelection(.enabled)
      .accessibilityLabel("Nama endpoint")
      .accessibilityValue(endpoint.absoluteString)
  }
}

private extension OAuthAuthorizationFailure {
  var title: LocalizedStringKey {
    switch self {
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

  var message: LocalizedStringKey {
    switch self {
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
}
