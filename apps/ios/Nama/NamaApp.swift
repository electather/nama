import SwiftUI

@main
struct NamaApp: App {
  private let clientVersion: String
  private let endpointStore: UserDefaultsVerifiedEndpointStore
  private let oauthClient: BetterAuthOAuthAuthorizationClient
  private let tokenStore: KeychainOAuthTokenStore
  private let scopedAccessVerifier: NamaOAuthScopedAccessVerifier
  private let authorizationSession: OAuthAuthorizationSession
  init() {
    guard
      let version = Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String, !version.isEmpty
    else {
      preconditionFailure("CFBundleShortVersionString must be configured")
    }
    clientVersion = version
    endpointStore = UserDefaultsVerifiedEndpointStore()
    oauthClient = BetterAuthOAuthAuthorizationClient()
    tokenStore = KeychainOAuthTokenStore()
    scopedAccessVerifier = NamaOAuthScopedAccessVerifier(clientVersion: version)
    authorizationSession = OAuthAuthorizationSession()
  }

  var body: some Scene {
    WindowGroup {
      ConnectionWindow(
        clientVersion: clientVersion,
        endpointStore: endpointStore,
        oauthClient: oauthClient,
        tokenStore: tokenStore,
        scopedAccessVerifier: scopedAccessVerifier,
        authorizationSession: authorizationSession
      )
    }
  }
}

private struct ConnectionWindow: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var connection: ConnectionFeature
  @State private var authorization: OAuthAuthorizationFeature

  init(
    clientVersion: String,
    endpointStore: any VerifiedEndpointStoring,
    oauthClient: any OAuthAuthorizationClient,
    tokenStore: any OAuthTokenStoring,
    scopedAccessVerifier: any OAuthScopedAccessVerifying,
    authorizationSession: OAuthAuthorizationSession
  ) {
    _connection = State(
      initialValue: ConnectionFeature(
        verifier: NamaSetupStatusVerifier(clientVersion: clientVersion),
        discovery: NWBrowserNamaDiscovery(),
        endpointStore: endpointStore
      )
    )
    _authorization = State(
      initialValue: OAuthAuthorizationFeature(
        client: oauthClient,
        tokenStore: tokenStore,
        scopedAccessVerifier: scopedAccessVerifier,
        session: authorizationSession
      )
    )
  }

  var body: some View {
    Group {
      if case .ready(let endpoint) = connection.state {
        OAuthAuthorizationView(
          feature: authorization,
          endpoint: endpoint,
          changeEndpoint: {
            await connection.changeEndpoint()
          }
        )
      } else {
        ConnectionRootView(feature: connection)
      }
    }
    .onAppear {
      if scenePhase == .active {
        connection.restoreSavedEndpoint()
        connection.flowDidEnter()
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        connection.restoreSavedEndpoint()
        connection.flowDidEnter()
      } else {
        connection.flowDidLeave()
      }
    }
  }
}
