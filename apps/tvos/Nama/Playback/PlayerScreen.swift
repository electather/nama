import Foundation
import SwiftUI

struct PlayerScreen: View {
  let player: NamaPlayer
  let backToFixtures: () -> Void

  @State private var showingDiagnostics = false

  var body: some View {
    ZStack {
      NamaPlayerSurface(player: player)
      SubtitleOverlay(cues: player.subtitleCues, clock: player.clock)
      VStack {
        if showingDiagnostics {
          DiagnosticsPanel(player: player)
        }
        Spacer()
        if case .failed(let failure) = player.state {
          failureControls(failure)
        } else {
          VStack(spacing: 18) {
            PlaybackClockControls(clock: player.clock, seek: player.seek)
            StablePlaybackControls(
              player: player,
              showingDiagnostics: $showingDiagnostics
            )
          }
          .padding(30)
          .background(.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 24))
        }
      }
      .padding(60)
    }
    .background(.black)
    .onPlayPauseCommand(perform: player.togglePlayPause)
    .onDisappear(perform: player.stop)
  }

  private func failureControls(_ failure: PlaybackFailure) -> some View {
    VStack(spacing: 22) {
      Text(failure.summary).font(.title2)
      HStack(spacing: 24) {
        Button("Retry", action: player.retry)
        Button("Back to Fixtures", action: backToFixtures)
      }
      .buttonStyle(.borderedProminent)
    }
    .padding(36)
    .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 24))
  }

}

private struct SubtitleOverlay: View {
  let cues: [PlaybackSubtitleCue]
  let clock: NamaPlaybackClock

  var body: some View {
    GeometryReader { geometry in
      ForEach(
        cues.filter {
          $0.startTime <= clock.state.currentTime && clock.state.currentTime <= $0.endTime
        }
      ) { cue in
        switch cue.body {
        case .text(let text):
          Text(text)
            .font(.title2.weight(.semibold))
            .multilineTextAlignment(.center)
            .padding(14)
            .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 10))
            .position(textPosition(cue, in: geometry.size))
        case .image(let image, let position, let canvasSize):
          Image(decorative: image, scale: 1)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .frame(
              width: geometry.size.width * position.width,
              height: geometry.size.height * position.height
            )
            .position(imagePosition(position, canvasSize: canvasSize, in: geometry.size))
        }
      }
    }
    .allowsHitTesting(false)
  }

  private func textPosition(_ cue: PlaybackSubtitleCue, in size: CGSize) -> CGPoint {
    guard let placement = cue.textPlacement else {
      return CGPoint(x: size.width / 2, y: size.height * 0.82)
    }
    return CGPoint(x: size.width * placement.x, y: size.height * placement.y)
  }

  private func imagePosition(_ rect: CGRect, canvasSize: CGSize, in size: CGSize) -> CGPoint {
    let normalized = canvasSize.width > 1 || canvasSize.height > 1
    let x = normalized ? (rect.midX / canvasSize.width) : rect.midX
    let y = normalized ? (rect.midY / canvasSize.height) : rect.midY
    return CGPoint(x: size.width * x, y: size.height * y)
  }
}

private struct PlaybackClockControls: View {
  let clock: NamaPlaybackClock
  let seek: (TimeInterval) -> Void

  var body: some View {
    VStack {
      Slider(
        value: Binding(
          get: { clock.state.seekTarget ?? clock.state.currentTime },
          set: seek
        ),
        in: 0...max(clock.state.duration, 1)
      )
      HStack {
        Text(duration(clock.state.currentTime))
        Spacer()
        Text(duration(clock.state.duration))
      }
      .monospacedDigit()
    }
  }

  private func duration(_ seconds: TimeInterval) -> String {
    let total = Int(max(0, seconds))
    let hours = total / 3_600
    let minutes = (total % 3_600) / 60
    let remainingSeconds = total % 60
    return hours == 0
      ? String(format: "%d:%02d", minutes, remainingSeconds)
      : String(format: "%d:%02d:%02d", hours, minutes, remainingSeconds)
  }
}

private struct StablePlaybackControls: View {
  let player: NamaPlayer
  @Binding var showingDiagnostics: Bool
  @FocusState private var focus: Control?

  private enum Control: Hashable {
    case playPause
    case audio
    case subtitles
    case diagnostics
  }

  var body: some View {
    HStack(spacing: 24) {
      Button(playPauseTitle, action: player.togglePlayPause)
        .focused($focus, equals: .playPause)

      Menu("Audio") {
        ForEach(player.audioTracks) { track in
          Button(selectionLabel(track.label, selected: track.id == player.activeAudioTrackID)) {
            player.selectAudioTrack(id: track.id)
          }
        }
      }
      .focused($focus, equals: .audio)

      Menu("Subtitles") {
        Button(selectionLabel("Off", selected: player.activeSubtitleTrackID == nil)) {
          player.selectSubtitleTrack(id: nil)
        }
        ForEach(player.subtitleTracks) { track in
          Button(selectionLabel(track.label, selected: track.id == player.activeSubtitleTrackID)) {
            player.selectSubtitleTrack(id: track.id)
          }
        }
      }
      .focused($focus, equals: .subtitles)

      Button(showingDiagnostics ? "Hide Diagnostics" : "Diagnostics") {
        showingDiagnostics.toggle()
      }
      .focused($focus, equals: .diagnostics)
    }
    .buttonStyle(.borderedProminent)
    .onAppear { focus = .playPause }
  }

  private var playPauseTitle: String {
    switch player.state {
    case .playing, .seeking: "Pause"
    default: "Play"
    }
  }

  private func selectionLabel(_ label: String, selected: Bool) -> String {
    selected ? "✓ \(label)" : label
  }
}

private struct DiagnosticsPanel: View {
  let player: NamaPlayer

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("State: \(stateLabel(player.state))")
      Text(
        "Time: \(player.clock.state.currentTime, format: .number.precision(.fractionLength(1))) s")
      Text(
        "Buffered: \(player.clock.state.bufferedPosition, format: .number.precision(.fractionLength(1))) s"
      )
      if let video = player.videoDiagnostics {
        Text("Container: \(video.container ?? "Unknown")")
        Text("Video: \(video.codec ?? "Unknown") \(resolution(video))")
        Text("Range: \(range(video.sourceDynamicRange)) → \(range(video.outputDynamicRange))")
      }
      Text("Audio: \(activeAudioLabel)")
      Text("Subtitles: \(activeSubtitleLabel)")
      Text("Advisory redirect origins: \(player.advisoryRedirectOriginCount)")
      if case .failed(let failure) = player.state {
        Text("Failure: \(failure.summary)")
      }
    }
    .font(.callout.monospaced())
    .padding(20)
    .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16))
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var activeAudioLabel: String {
    player.audioTracks.first { $0.id == player.activeAudioTrackID }?.label ?? "None"
  }

  private var activeSubtitleLabel: String {
    player.subtitleTracks.first { $0.id == player.activeSubtitleTrackID }?.label ?? "Off"
  }

  private func stateLabel(_ state: PlaybackState) -> String {
    switch state {
    case .idle: "Idle"
    case .loading: "Loading"
    case .playing: "Playing"
    case .paused: "Paused"
    case .seeking: "Seeking"
    case .ended: "Ended"
    case .failed: "Failed"
    }
  }

  private func resolution(_ video: PlaybackVideoDiagnostics) -> String {
    guard let width = video.width, let height = video.height else { return "" }
    return "\(width)×\(height)"
  }

  private func range(_ range: PlaybackDynamicRange) -> String {
    switch range {
    case .sdr: "SDR"
    case .hdr10: "HDR10"
    case .hdr10Plus: "HDR10+"
    case .dolbyVision: "Dolby Vision"
    case .hlg: "HLG"
    }
  }
}
