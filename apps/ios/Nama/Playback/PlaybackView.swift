import SwiftUI

nonisolated enum PlaybackTransportAction: Sendable, Equatable {
  case play
  case pause
}

nonisolated enum PlaybackPresentationPhase: Sendable, Equatable {
  case loading
  case controls(PlaybackTransportAction?)
  case ended
  case failed(NamaPlaybackFailure)

  init(playerState: NamaPlayerState) {
    switch playerState {
    case .idle, .loading:
      self = .loading

    case .playing, .buffering:
      self = .controls(.pause)

    case .paused:
      self = .controls(.play)

    case .seeking:
      self = .controls(nil)

    case .ended:
      self = .ended

    case .failed(let failure):
      self = .failed(failure)
    }
  }
}

enum PlaybackTrackPicker: Identifiable {
  case audio
  case subtitles

  var id: Self { self }
}

struct PlaybackView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @State private var trackPicker: PlaybackTrackPicker?

  let player: NamaPlayer
  let request: NamaPlayerRequest

  var body: some View {
    ZStack {
      Color.black
        .ignoresSafeArea()
      NamaPlayerSurface(player: player)
        .ignoresSafeArea()
      PlaybackChrome(
        player: player,
        phase: PlaybackPresentationPhase(playerState: player.state),
        trackPicker: $trackPicker,
        returnToDetails: stopAndDismiss
      )
    }
    .preferredColorScheme(.dark)
    .onAppear {
      player.load(request)
    }
    .onChange(of: request) { _, replacement in
      player.load(replacement)
    }
    .onChange(of: scenePhase) { _, phase in
      handleScenePhase(phase)
    }
    .sheet(item: $trackPicker) { picker in
      PlaybackTrackPickerView(player: player, picker: picker)
    }
    #if os(tvOS) || os(macOS)
      .onExitCommand(perform: stopAndDismiss)
    #endif
  }

  private func handleScenePhase(_ phase: ScenePhase) {
    #if os(iOS) || os(tvOS)
      if phase == .background {
        stopAndDismiss()
      }
    #else
      _ = phase
    #endif
  }

  private func stopAndDismiss() {
    player.stop()
    dismiss()
  }
}

struct PlaybackChrome: View {
  private static let spacing: CGFloat = 24

  let player: NamaPlayer
  let phase: PlaybackPresentationPhase
  @Binding var trackPicker: PlaybackTrackPicker?
  let returnToDetails: () -> Void

  var body: some View {
    VStack(spacing: Self.spacing) {
      HStack {
        Button(action: returnToDetails) {
          Label("Back to Details", systemImage: "xmark")
        }
        .buttonStyle(.bordered)
        Spacer()
      }

      Spacer()

      PlaybackPhaseContent(
        player: player,
        phase: phase,
        trackPicker: $trackPicker,
        returnToDetails: returnToDetails
      )
    }
    .padding()
  }
}

private struct PlaybackPhaseContent: View {
  let player: NamaPlayer
  let phase: PlaybackPresentationPhase
  @Binding var trackPicker: PlaybackTrackPicker?
  let returnToDetails: () -> Void

  @ViewBuilder
  var body: some View {
    switch phase {
    case .loading:
      PlaybackLoadingView()

    case .controls(let transportAction):
      PlaybackActiveControls(
        player: player,
        transportAction: transportAction,
        showAudioTracks: { trackPicker = .audio },
        showSubtitleTracks: { trackPicker = .subtitles }
      )

    case .ended:
      PlaybackTerminalView(
        title: "Playback Finished",
        systemImage: "checkmark.circle",
        description: "Return to details to choose what to watch next.",
        returnToDetails: returnToDetails
      )

    case .failed(let failure):
      PlaybackTerminalView(
        title: "Playback Unavailable",
        systemImage: "exclamationmark.triangle",
        description: failure.summary,
        returnToDetails: returnToDetails
      )
    }
  }
}

private struct PlaybackLoadingView: View {
  private static let spacing: CGFloat = 12

  var body: some View {
    VStack(spacing: Self.spacing) {
      ProgressView()
        .controlSize(.large)
      Text("Loading Video")
        .font(.headline)
    }
    .foregroundStyle(.white)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Loading video")
  }
}

private struct PlaybackTerminalView: View {
  let title: LocalizedStringResource
  let systemImage: String
  let description: LocalizedStringResource
  let returnToDetails: () -> Void

  var body: some View {
    ContentUnavailableView {
      Label {
        Text(title)
      } icon: {
        Image(systemName: systemImage)
      }
    } description: {
      Text(description)
    } actions: {
      Button("Back to Details", action: returnToDetails)
        .buttonStyle(.borderedProminent)
    }
    .foregroundStyle(.white)
  }
}
