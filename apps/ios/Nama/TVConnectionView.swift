#if os(tvOS)
  import SwiftUI

  struct TVConnectionView: View {
    @Bindable var feature: ConnectionFeature
    @FocusState private var focusedControl: Focus?

    var body: some View {
      NavigationStack {
        ScrollView {
          content
            .frame(maxWidth: 900, alignment: .leading)
            .padding(64)
        }
      }
      .defaultFocus($focusedControl, preferredFocus)
    }

    @ViewBuilder
    private var content: some View {
      switch feature.state {
      case .editing(let showsValidationError):
        VStack(alignment: .leading, spacing: 28) {
          Text("Connect to Nama")
            .font(.largeTitle)
          addressField
          if showsValidationError {
            Text(EndpointValidationError.invalid.message)
              .foregroundStyle(.red)
          }
          actionButtons(feature.state.actions)
        }
      case .verifying(let endpoint):
        VStack(alignment: .leading, spacing: 28) {
          addressField
          HStack(spacing: 20) {
            ProgressView()
            TVEndpointValue(endpoint: endpoint)
          }
          actionButtons(feature.state.actions)
        }
      case .ready(let endpoint):
        VStack(alignment: .leading, spacing: 28) {
          Text("Nama is ready")
            .font(.largeTitle)
          TVEndpointValue(endpoint: endpoint)
          actionButtons(feature.state.actions)
        }
      case .setupRequired(let endpoint):
        VStack(alignment: .leading, spacing: 28) {
          Text("Finish setting up Nama")
            .font(.largeTitle)
          TVEndpointValue(endpoint: endpoint)
          Text("Run `nama setup` from a trusted computer, then try again.")
            .foregroundStyle(.secondary)
          actionButtons(feature.state.actions)
        }
      case .failed(let endpoint, let failure):
        VStack(alignment: .leading, spacing: 28) {
          Text(failure.message)
            .font(.title2)
          TVEndpointValue(endpoint: endpoint)
          actionButtons(feature.state.actions)
        }
      }
    }

    private var addressField: some View {
      TextField("Nama endpoint", text: $feature.address, prompt: Text("https://nama.example.com"))
        .textContentType(.URL)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($focusedControl, equals: .address)
        .onSubmit {
          feature.submit()
        }
        .onChange(of: feature.address) {
          feature.addressDidChange()
        }
    }

    private func actionButtons(_ actions: [ConnectionAction]) -> some View {
      HStack(spacing: 20) {
        ForEach(actions, id: \.self) { action in
          actionButton(action)
        }
      }
      .focusSection()
    }

    @ViewBuilder
    private func actionButton(_ action: ConnectionAction) -> some View {
      switch action {
      case .connect:
        Button("Connect") {
          feature.submit()
        }
        .buttonStyle(.borderedProminent)
        .focused($focusedControl, equals: .connect)
      case .cancel:
        Button("Cancel", role: .cancel) {
          feature.cancel()
        }
        .focused($focusedControl, equals: .cancel)
      case .retry:
        Button("Retry") {
          feature.retry()
        }
        .buttonStyle(.borderedProminent)
        .focused($focusedControl, equals: .retry)
      case .changeEndpoint:
        Button("Change Endpoint") {
          feature.changeEndpoint()
        }
        .focused($focusedControl, equals: .changeEndpoint)
      }
    }

    private var preferredFocus: Focus? {
      switch feature.state {
      case .editing, .verifying:
        .address
      case .ready:
        .changeEndpoint
      case .setupRequired, .failed:
        .retry
      }
    }

    private enum Focus: Hashable {
      case address
      case connect
      case cancel
      case retry
      case changeEndpoint
    }
  }

  private struct TVEndpointValue: View {
    let endpoint: NamaEndpoint

    var body: some View {
      VStack(alignment: .leading, spacing: 8) {
        Text("Endpoint")
          .font(.headline)
        Text(endpoint.absoluteString)
          .font(.body.monospaced())
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
    }
  }
#endif
