import SwiftUI

@main
struct NamaApp: App {
  private let clientVersion: String
  private let endpointStore: UserDefaultsVerifiedEndpointStore
  private let oauthClient: BetterAuthOAuthAuthorizationClient
  private let tokenStore: KeychainOAuthTokenStore
  private let libraryClient: NamaLibraryClient
  private let artworkLoader: HomeArtworkLoader
  private let authorizationSession: OAuthAuthorizationSession

  init() {
    guard
      let version = Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String, !version.isEmpty
    else {
      preconditionFailure("CFBundleShortVersionString must be configured")
    }
    let newTokenStore = KeychainOAuthTokenStore()
    clientVersion = version
    endpointStore = UserDefaultsVerifiedEndpointStore()
    oauthClient = BetterAuthOAuthAuthorizationClient()
    tokenStore = newTokenStore
    let newLibraryClient = NamaLibraryClient(
      clientVersion: version,
      tokenStore: newTokenStore
    )
    libraryClient = newLibraryClient
    artworkLoader = HomeArtworkLoader(resolver: newLibraryClient)
    authorizationSession = OAuthAuthorizationSession()
  }

  var body: some Scene {
    WindowGroup {
      ConnectionWindow(
        clientVersion: clientVersion,
        endpointStore: endpointStore,
        oauthClient: oauthClient,
        tokenStore: tokenStore,
        libraryClient: libraryClient,
        artworkLoader: artworkLoader,
        authorizationSession: authorizationSession
      )
    }
  }
}

private struct ConnectionWindow: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var connection: ConnectionFeature
  @State private var authorization: OAuthAuthorizationFeature
  @State private var home: HomeFeature
  @State private var movieDetails: MovieDetailsFeature
  @State private var pendingPlayIntent: MoviePlayIntent?

  init(
    clientVersion: String,
    endpointStore: any VerifiedEndpointStoring,
    oauthClient: any OAuthAuthorizationClient,
    tokenStore: any OAuthTokenStoring,
    libraryClient: NamaLibraryClient,
    artworkLoader: any HomeArtworkLoading,
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
        scopedAccessVerifier: libraryClient,
        session: authorizationSession
      )
    )
    _home = State(
      initialValue: HomeFeature(loader: libraryClient, artworkLoader: artworkLoader)
    )
    _movieDetails = State(
      initialValue: MovieDetailsFeature(loader: libraryClient, artworkLoader: artworkLoader)
    )
  }

  var body: some View {
    Group {
      if case .ready(let endpoint) = connection.state {
        AuthorizedConsumerRootView(
          authorization: authorization,
          home: home,
          movieDetails: movieDetails,
          emitPlayIntent: capturePlayIntent,
          endpoint: endpoint
        ) {
          home.deactivate()
          await connection.changeEndpoint()
        }
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

  private func capturePlayIntent(_ intent: MoviePlayIntent) {
    pendingPlayIntent = intent
  }
}

private struct AuthorizedConsumerRootView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var retryGeneration = 0

  let authorization: OAuthAuthorizationFeature
  let home: HomeFeature
  let movieDetails: MovieDetailsFeature
  let emitPlayIntent: @MainActor (MoviePlayIntent) -> Void
  let endpoint: NamaEndpoint
  let changeEndpoint: @MainActor () async -> Void

  var body: some View {
    Group {
      if let homeAuthorization {
        NavigationStack {
          HomeView(
            feature: home,
            authorization: homeAuthorization,
            changeEndpoint: changeEndpoint
          ) {
            await discardRejectedAuthorization(for: homeAuthorization)
          }
          .navigationDestination(for: MovieDetailsSelection.self) { selection in
            MovieDetailsView(
              feature: movieDetails,
              selection: selection,
              authorization: homeAuthorization,
              emitPlayIntent: emitPlayIntent
            ) {
              await discardRejectedAuthorization(for: homeAuthorization)
            }
          }
        }
      } else {
        OAuthAuthorizationView(
          feature: authorization,
          endpoint: endpoint,
          changeEndpoint: changeEndpoint
        ) {
          retryGeneration &+= 1
        }
      }
    }
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
      await authorization.run(endpoint)
    }
  }

  private func discardRejectedAuthorization(
    for authorizationIdentity: HomeAuthorizationIdentity
  ) async {
    guard
      case .authorized(let rejected) = authorization.state,
      authorization.session.generation == authorizationIdentity.generation
    else {
      return
    }
    switch await authorization.discardRejectedAuthorization(
      rejected,
      generation: authorizationIdentity.generation
    ) {
    case .discarded:
      retryGeneration &+= 1

    case .storageUnavailable, .stale:
      return
    }
  }

  private var homeAuthorization: HomeAuthorizationIdentity? {
    HomeAuthorizationIdentity(
      currentEndpoint: endpoint,
      authorizationState: authorization.state,
      generation: authorization.session.generation
    )
  }
}

private struct OAuthAuthorizationTaskID: Hashable {
  let endpoint: NamaEndpoint
  let retryGeneration: Int
  let isActive: Bool
}
