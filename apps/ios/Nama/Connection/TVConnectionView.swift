#if os(tvOS)
  import SwiftUI

  struct TVConnectionView: View {
    @Bindable var feature: ConnectionFeature
    @FocusState private var focusedControl: Focus?

    var body: some View {
      NavigationStack {
        ScrollView {
          content
            .frame(maxWidth: Layout.maximumContentWidth, alignment: .leading)
            .padding(Layout.contentPadding)
        }
      }
      .defaultFocus($focusedControl, preferredFocus)
    }

    @ViewBuilder
    private var content: some View {
      switch feature.state {
      case .editing(let validationError):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text("Connect to Nama")
            .font(.largeTitle)
          NamaDiscoveryContent(feature: feature)
          addressField
          if let validationError {
            Text(validationError.message)
              .foregroundStyle(.red)
          }
          actionButtons(feature.state.actions)
        }

      case .confirmingHTTP(let endpoint, _), .pausedHTTPRestoration(let endpoint):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text(LocalHTTPConfirmationCopy.title)
            .font(.largeTitle)
          Text(LocalHTTPConfirmationCopy.message)
            .fixedSize(horizontal: false, vertical: true)
          TVEndpointValue(endpoint: endpoint)
          HTTPConnectionWarning(isPresented: feature.state.showsUnencryptedHTTPWarning)
          actionButtons(feature.state.actions)
        }

      case .checkingHTTPAcknowledgement(let endpoint), .verifying(let endpoint):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          NamaDiscoveryContent(feature: feature)
          addressField
          HStack(spacing: Layout.actionSpacing) {
            ProgressView()
            TVEndpointValue(endpoint: endpoint)
          }
          HTTPConnectionWarning(isPresented: feature.state.showsUnencryptedHTTPWarning)
          actionButtons(feature.state.actions)
        }

      case .ready(let endpoint):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text("Nama is ready")
            .font(.largeTitle)
          TVEndpointValue(endpoint: endpoint)
          HTTPConnectionWarning(isPresented: feature.state.showsUnencryptedHTTPWarning)
          actionButtons(feature.state.actions)
        }

      case .setupRequired(let endpoint):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text("Finish setting up Nama")
            .font(.largeTitle)
          TVEndpointValue(endpoint: endpoint)
          Text("Run `nama setup` from a trusted computer, then try again.")
            .foregroundStyle(.secondary)
          HTTPConnectionWarning(isPresented: feature.state.showsUnencryptedHTTPWarning)
          actionButtons(feature.state.actions)
        }

      case .failed(let endpoint, let failure):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text(failure.message)
            .font(.title2)
          TVEndpointValue(endpoint: endpoint)
          HTTPConnectionWarning(isPresented: feature.state.showsUnencryptedHTTPWarning)
          actionButtons(feature.state.actions)
        }

      case .requiresHTTPS(let endpoint):
        VStack(alignment: .leading, spacing: Layout.sectionSpacing) {
          Text(SavedEndpointHTTPSRequiredCopy.title)
            .font(.largeTitle)
          Text(SavedEndpointHTTPSRequiredCopy.message)
            .foregroundStyle(.red)
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
      HStack(spacing: Layout.actionSpacing) {
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

      case .continueWithoutHTTPS:
        Button("Continue") {
          feature.continueWithoutHTTPS()
        }
        .buttonStyle(.borderedProminent)
        .focused($focusedControl, equals: .continueWithoutHTTPS)

      case .retry:
        Button("Retry") {
          feature.retry()
        }
        .buttonStyle(.borderedProminent)
        .focused($focusedControl, equals: .retry)

      case .changeEndpoint:
        Button("Change Endpoint") {
          Task {
            await feature.changeEndpoint()
          }
        }
        .focused($focusedControl, equals: .changeEndpoint)
      }
    }

    private var preferredFocus: Focus? {
      Focus(feature.state.televisionFocus)
    }

    private enum Layout {
      static let maximumContentWidth: CGFloat = 900
      static let contentPadding: CGFloat = 64
      static let sectionSpacing: CGFloat = 28
      static let actionSpacing: CGFloat = 20
      static let endpointSpacing: CGFloat = 8
    }

    private enum Focus: Hashable {
      case address
      case connect
      case cancel
      case continueWithoutHTTPS
      case retry
      case changeEndpoint

      init(_ focus: TelevisionConnectionFocus) {
        switch focus {
        case .address:
          self = .address

        case .action(let action):
          switch action {
          case .connect:
            self = .connect

          case .cancel:
            self = .cancel

          case .continueWithoutHTTPS:
            self = .continueWithoutHTTPS

          case .retry:
            self = .retry

          case .changeEndpoint:
            self = .changeEndpoint
          }
        }
      }
    }
  }

  private struct TVEndpointValue: View {
    private static let verticalSpacing: CGFloat = 8

    private let address: String

    init(endpoint: NamaEndpoint) {
      address = endpoint.absoluteString
    }

    init(endpoint: HTTPSRequiredEndpoint) {
      address = endpoint.absoluteString
    }

    var body: some View {
      VStack(alignment: .leading, spacing: Self.verticalSpacing) {
        Text("Endpoint")
          .font(.headline)
        Text(address)
          .font(.body.monospaced())
          .fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
    }
  }
#endif
