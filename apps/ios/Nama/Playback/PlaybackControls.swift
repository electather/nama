import SwiftUI

struct PlaybackActiveControls: View {
  private static let spacing: CGFloat = 16
  private static let backgroundOpacity = 0.72

  let player: NamaPlayer
  let transportAction: PlaybackTransportAction?
  let showAudioTracks: () -> Void
  let showSubtitleTracks: () -> Void

  var body: some View {
    VStack(spacing: Self.spacing) {
      PlaybackTransientStatus(state: player.state)
      PlaybackTransportControls(
        player: player,
        action: transportAction
      )
      PlaybackTimelineControls(player: player)
      PlaybackTrackControls(
        hasAudioTracks: !player.audioTracks.isEmpty,
        hasSubtitleTracks: !player.subtitleTracks.isEmpty,
        showAudioTracks: showAudioTracks,
        showSubtitleTracks: showSubtitleTracks
      )
    }
    .padding()
    .foregroundStyle(.white)
    .background(.black.opacity(Self.backgroundOpacity))
    #if os(tvOS)
      .focusSection()
    #endif
  }
}

private struct PlaybackTransientStatus: View {
  let state: NamaPlayerState

  @ViewBuilder
  var body: some View {
    if state == .buffering {
      Label("Buffering", systemImage: "ellipsis")
        .font(.headline)
    } else if state == .seeking {
      Label("Seeking", systemImage: "arrow.left.arrow.right")
        .font(.headline)
    }
  }
}

private struct PlaybackTransportControls: View {
  private static let spacing: CGFloat = 24
  private static let seekInterval: TimeInterval = 15

  let player: NamaPlayer
  let action: PlaybackTransportAction?

  var body: some View {
    HStack(spacing: Self.spacing) {
      seekButton(
        title: "Back 15 Seconds",
        accessibilityLabel: "Back 15 seconds",
        systemImage: "gobackward.15",
        offset: -Self.seekInterval
      )
      transportControl
      seekButton(
        title: "Forward 15 Seconds",
        accessibilityLabel: "Forward 15 seconds",
        systemImage: "goforward.15",
        offset: Self.seekInterval
      )
    }
    .buttonStyle(.bordered)
    .disabled(action == nil)
  }

  @ViewBuilder
  private var transportControl: some View {
    switch action {
    case .play:
      transportButton(
        title: "Play",
        systemImage: "play.fill",
        action: player.play
      )

    case .pause:
      transportButton(
        title: "Pause",
        systemImage: "pause.fill",
        action: player.pause
      )

    case nil:
      ProgressView()
        .controlSize(.large)
        .accessibilityLabel("Seeking")
    }
  }

  private func seekButton(
    title: LocalizedStringKey,
    accessibilityLabel: LocalizedStringKey,
    systemImage: String,
    offset: TimeInterval
  ) -> some View {
    Button {
      player.seek(to: player.clock.state.position + offset)
    } label: {
      Label(title, systemImage: systemImage)
    }
    .labelStyle(.iconOnly)
    .accessibilityLabel(accessibilityLabel)
  }

  private func transportButton(
    title: LocalizedStringResource,
    systemImage: String,
    action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Label {
        Text(title)
      } icon: {
        Image(systemName: systemImage)
      }
    }
    .labelStyle(.iconOnly)
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .accessibilityLabel(Text(title))
    #if os(macOS)
      .keyboardShortcut(.space, modifiers: [])
    #endif
  }
}

private struct PlaybackTimelineControls: View {
  private static let spacing: CGFloat = 4

  @State private var scrubPosition: TimeInterval?

  let player: NamaPlayer

  var body: some View {
    let clock = player.clock.state
    let displayedPosition = scrubPosition ?? clock.position

    VStack(spacing: Self.spacing) {
      if let duration = clock.duration {
        let accessibleValue = accessibilityValue(
          position: displayedPosition,
          duration: duration
        )
        #if os(tvOS)
          ProgressView(value: displayedPosition, total: duration)
            .accessibilityLabel("Playback position")
            .accessibilityValue(accessibleValue)
        #else
          Slider(
            value: scrubBinding(currentPosition: clock.position),
            in: 0...duration,
            onEditingChanged: handleScrubbing
          )
          .accessibilityLabel("Playback position")
          .accessibilityValue(accessibleValue)
        #endif
      }

      PlaybackTimeReadout(
        position: displayedPosition,
        duration: clock.duration
      )
    }
  }

  private func accessibilityValue(
    position: TimeInterval,
    duration: TimeInterval
  ) -> Text {
    let elapsed = Duration.seconds(position).formatted(
      .time(pattern: .hourMinuteSecond)
    )
    let total = Duration.seconds(duration).formatted(
      .time(pattern: .hourMinuteSecond)
    )
    return Text("Elapsed \(elapsed) of \(total)")
  }

  private func scrubBinding(currentPosition: TimeInterval) -> Binding<TimeInterval> {
    Binding(
      get: { scrubPosition ?? currentPosition },
      set: { scrubPosition = $0 }
    )
  }

  private func handleScrubbing(_ isEditing: Bool) {
    if isEditing {
      scrubPosition = player.clock.state.position
    } else if let target = scrubPosition {
      scrubPosition = nil
      player.seek(to: target)
    }
  }
}

enum PlaybackTimeReadoutAccessibility: Equatable {
  case hidden
  case elapsed(Duration)

  init(position: TimeInterval, duration: TimeInterval?) {
    if duration == nil {
      self = .elapsed(.seconds(position))
    } else {
      self = .hidden
    }
  }
}

private struct PlaybackTimeReadout: View {
  let position: TimeInterval
  let duration: TimeInterval?

  @ViewBuilder
  var body: some View {
    switch PlaybackTimeReadoutAccessibility(position: position, duration: duration) {
    case .hidden:
      content
        .accessibilityHidden(true)

    case .elapsed(let elapsed):
      content
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Playback position")
        .accessibilityValue(
          Text(elapsed, format: .time(pattern: .hourMinuteSecond))
        )
    }
  }

  private var content: some View {
    HStack {
      Text(Duration.seconds(position), format: .time(pattern: .hourMinuteSecond))
      Spacer()
      if let duration {
        Text(Duration.seconds(duration), format: .time(pattern: .hourMinuteSecond))
      }
    }
    .font(.callout.monospacedDigit())
  }
}

private struct PlaybackTrackControls: View {
  private static let spacing: CGFloat = 12

  let hasAudioTracks: Bool
  let hasSubtitleTracks: Bool
  let showAudioTracks: () -> Void
  let showSubtitleTracks: () -> Void

  var body: some View {
    HStack(spacing: Self.spacing) {
      Button("Audio", systemImage: "waveform", action: showAudioTracks)
        .disabled(!hasAudioTracks)
      Button("Subtitles", systemImage: "captions.bubble", action: showSubtitleTracks)
        .disabled(!hasSubtitleTracks)
    }
    .buttonStyle(.bordered)
  }
}
