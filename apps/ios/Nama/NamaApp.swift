import SwiftUI

@main
struct NamaApp: App {
  @State private var connection: ConnectionFeature

  init() {
    guard
      let version = Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String, !version.isEmpty
    else {
      preconditionFailure("CFBundleShortVersionString must be configured")
    }
    _connection = State(
      initialValue: ConnectionFeature(
        verifier: NamaSetupStatusVerifier(clientVersion: version)
      )
    )
  }

  var body: some Scene {
    WindowGroup {
      ConnectionRootView(feature: connection)
    }
  }
}
