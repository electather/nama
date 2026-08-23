import SwiftUI

@main
struct NamaApp: App {
  private let clientVersion: String

  init() {
    guard
      let version = Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String, !version.isEmpty
    else {
      preconditionFailure("CFBundleShortVersionString must be configured")
    }
    clientVersion = version
  }

  var body: some Scene {
    WindowGroup {
      ConnectionWindow(clientVersion: clientVersion)
    }
  }
}

private struct ConnectionWindow: View {
  @State private var connection: ConnectionFeature

  init(clientVersion: String) {
    _connection = State(
      initialValue: ConnectionFeature(
        verifier: NamaSetupStatusVerifier(clientVersion: clientVersion),
        discovery: NWBrowserNamaDiscovery()
      )
    )
  }

  var body: some View {
    ConnectionRootView(feature: connection)
  }
}
