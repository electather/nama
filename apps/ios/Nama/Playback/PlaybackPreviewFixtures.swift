#if DEBUG
  import SwiftUI

  @MainActor
  enum PlaybackPreviewPlayer {
    case available(NamaPlayer)
    case unavailable

    init(_ makePlayer: () throws -> NamaPlayer) {
      do {
        self = .available(try makePlayer())
      } catch {
        self = .unavailable
      }
    }
  }

  @MainActor
  struct PlaybackPreviewUnavailableView: View {
    var body: some View {
      ContentUnavailableView(
        "Preview unavailable",
        systemImage: "play.slash",
        description: Text("The player could not be created.")
      )
      .preferredColorScheme(.dark)
    }
  }

  @MainActor
  private struct PlaybackChromePreview: View {
    @State private var previewPlayer: PlaybackPreviewPlayer
    @State private var trackPicker: PlaybackTrackPicker?

    let phase: PlaybackPresentationPhase

    init(phase: PlaybackPresentationPhase) {
      self.phase = phase
      _previewPlayer = State(
        initialValue: PlaybackPreviewPlayer {
          try NamaPlayer { position in
            _ = position
          }
        }
      )
    }

    var body: some View {
      ZStack {
        Color.black
        switch previewPlayer {
        case .available(let player):
          PlaybackChrome(
            player: player,
            phase: phase,
            trackPicker: $trackPicker,
            returnToDetails: player.stop
          )

        case .unavailable:
          PlaybackPreviewUnavailableView()
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

  #Preview("Playback unavailable") {
    PlaybackPreviewUnavailableView()
  }
#endif
