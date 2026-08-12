import NamaAPI
import SwiftUI

private let healthClientInterface = (any Nama_Api_V1_HealthServiceClientInterface).self

@main
struct NamaApp: App {
  var body: some Scene {
    WindowGroup {
      rootView
    }
  }

  @ViewBuilder
  private var rootView: some View {
    #if DEBUG
      switch PlayerLabLaunchConfiguration.parse(arguments: ProcessInfo.processInfo.arguments) {
      case .product:
        Text("Nama")
      case .lab(let baseURL):
        PlayerLabScreen(baseURL: baseURL)
      case .invalid(let message):
        PlayerLabFailureScreen(message: message, retry: nil)
      }
    #else
      Text("Nama")
    #endif
  }
}
