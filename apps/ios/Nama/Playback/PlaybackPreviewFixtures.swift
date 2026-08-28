#if DEBUG
  import SwiftUI

  @MainActor
  private struct PlaybackChromePreview: View {
    @State private var player: NamaPlayer?
    @State private var trackPicker: PlaybackTrackPicker?

    let phase: PlaybackPresentationPhase

    init(phase: PlaybackPresentationPhase) {
      self.phase = phase
      _player = State(
        initialValue: try? NamaPlayer { position in
          _ = position
        }
      )
    }

    var body: some View {
      ZStack {
        Color.black
        if let player {
          PlaybackChrome(
            player: player,
            phase: phase,
            trackPicker: $trackPicker,
            returnToDetails: player.stop
          )
        }
      }
      .preferredColorScheme(.dark)
    }
  }

  #Preview("Playback loading") {
    PlaybackChromePreview(phase: .loading)
  }

  #Preview("Playback controls") {
    PlaybackChromePreview(phase: .controls(.play))
  }

  #Preview("Playback failure") {
    PlaybackChromePreview(
      phase: .failed(.sanitized(.network))
    )
  }
#endif
