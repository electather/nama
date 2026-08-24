import SwiftUI

struct ConnectionRootView: View {
  let feature: ConnectionFeature

  var body: some View {
    content

      .onDisappear {
        feature.flowDidLeave()
      }
  }

  @ViewBuilder
  private var content: some View {
    #if os(tvOS)
      TVConnectionView(feature: feature)
    #else
      ConnectionFormView(feature: feature)
    #endif
  }
}

#if !os(tvOS)
  private struct ConnectionFormView: View {
    @Bindable var feature: ConnectionFeature

    var body: some View {
      NavigationStack {
        content
          .navigationTitle(navigationTitle)
      }
    }

    private var navigationTitle: LocalizedStringResource {
      switch feature.state {
      case .editing, .verifying:
        "Connect to Nama"

      case .ready, .setupRequired, .failed, .requiresHTTPS:
        "Nama Endpoint"
      }
    }

    @ViewBuilder
    private var content: some View {
      switch feature.state {
      case .editing(let validationError):
        EntryForm(feature: feature, validationError: validationError)

      case .verifying(let endpoint):
        VerifyingForm(feature: feature, endpoint: endpoint)

      case .ready(let endpoint):
        ReadyForm(feature: feature, endpoint: endpoint)

      case .setupRequired(let endpoint):
        SetupRequiredForm(feature: feature, endpoint: endpoint)

      case .failed(let endpoint, let failure):
        FailureForm(feature: feature, endpoint: endpoint, failure: failure)

      case .requiresHTTPS(let endpoint):
        HTTPSRequiredForm(feature: feature, endpoint: endpoint)
      }
    }
  }

  private struct EntryForm: View {
    @Bindable var feature: ConnectionFeature
    let validationError: EndpointValidationError?

    var body: some View {
      Form {
        Section {
          NamaDiscoveryContent(feature: feature)
        }
        AddressFields(feature: feature, validationError: validationError)
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct VerifyingForm: View {
    @Bindable var feature: ConnectionFeature
    let endpoint: NamaEndpoint

    var body: some View {
      Form {
        Section {
          NamaDiscoveryContent(feature: feature)
        }
        AddressFields(feature: feature, validationError: nil)
        Section {
          ProgressView()
            .frame(maxWidth: .infinity)
          EndpointValue(endpoint: endpoint)
        }
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct ReadyForm: View {
    let feature: ConnectionFeature
    let endpoint: NamaEndpoint

    var body: some View {
      Form {
        Section {
          Text("Nama is ready")
            .font(.headline)
          EndpointValue(endpoint: endpoint)
        }
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct SetupRequiredForm: View {
    let feature: ConnectionFeature
    let endpoint: NamaEndpoint

    var body: some View {
      Form {
        Section {
          Text("Finish setting up Nama")
            .font(.headline)
          EndpointValue(endpoint: endpoint)
          Text("Run `nama setup` from a trusted computer, then try again.")
            .foregroundStyle(.secondary)
        }
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct FailureForm: View {
    let feature: ConnectionFeature
    let endpoint: NamaEndpoint
    let failure: VerificationFailure

    var body: some View {
      Form {
        Section {
          Text(failure.message)
            .foregroundStyle(.red)
          EndpointValue(endpoint: endpoint)
        }
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct HTTPSRequiredForm: View {
    let feature: ConnectionFeature
    let endpoint: HTTPSRequiredEndpoint

    var body: some View {
      Form {
        Section {
          Text(SavedEndpointHTTPSRequiredCopy.title)
            .font(.headline)
          Text(SavedEndpointHTTPSRequiredCopy.message)
            .foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true)
          EndpointValue(endpoint: endpoint)
        }
        Section {
          ConnectionActionButtons(feature: feature, actions: feature.state.actions)
        }
      }
      .connectionFormLayout()
    }
  }

  private struct AddressFields: View {
    @Bindable var feature: ConnectionFeature
    let validationError: EndpointValidationError?

    var body: some View {
      Section("Nama endpoint") {
        TextField("Nama endpoint", text: $feature.address, prompt: Text("https://nama.example.com"))
          .textContentType(.URL)
          .autocorrectionDisabled()
          #if os(iOS)
            .keyboardType(.URL)
            .textInputAutocapitalization(.never)
            .submitLabel(.go)
          #endif
          .onSubmit {
            feature.submit()
          }
          .onChange(of: feature.address) {
            feature.addressDidChange()
          }
        if let validationError {
          Text(validationError.message)
            .foregroundStyle(.red)
        }
      }
    }
  }

  private struct ConnectionActionButtons: View {
    let feature: ConnectionFeature
    let actions: [ConnectionAction]

    var body: some View {
      ForEach(actions, id: \.self) { action in
        ConnectionActionButton(feature: feature, action: action)
      }
    }
  }

  private struct ConnectionActionButton: View {
    let feature: ConnectionFeature
    let action: ConnectionAction

    @ViewBuilder
    var body: some View {
      switch action {
      case .connect:
        Button("Connect") {
          feature.submit()
        }
        .buttonStyle(.borderedProminent)

      case .cancel:
        Button("Cancel", role: .cancel) {
          feature.cancel()
        }

      case .retry:
        Button("Retry") {
          feature.retry()
        }
        .buttonStyle(.borderedProminent)

      case .changeEndpoint:
        Button("Change Endpoint") {
          Task {
            await feature.changeEndpoint()
          }
        }
      }
    }
  }

  private struct EndpointValue: View {
    private let address: String

    init(endpoint: NamaEndpoint) {
      address = endpoint.absoluteString
    }

    init(endpoint: HTTPSRequiredEndpoint) {
      address = endpoint.absoluteString
    }

    var body: some View {
      LabeledContent("Endpoint") {
        Text(address)
          .font(.body.monospaced())
          .multilineTextAlignment(.trailing)
          .textSelection(.enabled)
      }
    }
  }

  private enum ConnectionFormLayoutMetrics {
    static let maximumContentWidth: CGFloat = 640
    static let minimumWindowWidth: CGFloat = 520
    static let minimumWindowHeight: CGFloat = 420
  }

  private struct ConnectionFormLayout: ViewModifier {
    func body(content: Content) -> some View {
      content
        .frame(maxWidth: ConnectionFormLayoutMetrics.maximumContentWidth)
        .frame(maxWidth: .infinity)
        #if os(macOS)
          .frame(
            minWidth: ConnectionFormLayoutMetrics.minimumWindowWidth,
            minHeight: ConnectionFormLayoutMetrics.minimumWindowHeight
          )
        #endif
    }
  }

  // Sibling views in this file share this modifier; `private` would hide it.
  // swiftlint:disable:next extension_access_modifier
  extension View {
    // swiftlint:disable:next strict_fileprivate
    fileprivate func connectionFormLayout() -> some View {
      modifier(ConnectionFormLayout())
    }
  }
#endif
