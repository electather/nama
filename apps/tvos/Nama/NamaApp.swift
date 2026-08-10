import NamaAPI
import SwiftUI

private let healthClientInterface = (any Nama_Api_V1_HealthServiceClientInterface).self

@main
struct NamaApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Nama")
        }
    }
}
