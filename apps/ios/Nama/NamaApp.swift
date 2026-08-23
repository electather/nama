import SwiftUI

@main
struct NamaApp: App {
  private let clientVersion: String
  private let endpointStore: UserDefaultsVerifiedEndpointStore

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
  }

  var body: some Scene {
    WindowGroup {
      ConnectionWindow(clientVersion: clientVersion, endpointStore: endpointStore)
    }
  }
}

private struct ConnectionWindow: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var connection: ConnectionFeature

  init(
    clientVersion: String,
    endpointStore: any VerifiedEndpointStoring
  ) {
    _connection = State(
      initialValue: ConnectionFeature(
        verifier: NamaSetupStatusVerifier(clientVersion: clientVersion),
        endpointStore: endpointStore
      )
    )
  }

  var body: some View {
    ConnectionRootView(feature: connection)
      .onAppear {
        if scenePhase == .active {
          connection.restoreSavedEndpoint()
        }
      }
      .onChange(of: scenePhase) { _, phase in
        if phase == .active {
          connection.restoreSavedEndpoint()
        } else {
          connection.flowDidLeave()
        }
      }
  }
}
