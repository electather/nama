import AetherEngine
import SwiftUI

struct NamaPlayerSurface: View {
  let player: NamaPlayer

  var body: some View {
    AetherPlayerSurface(engine: player.aetherEngine)
      .ignoresSafeArea()
  }
}
