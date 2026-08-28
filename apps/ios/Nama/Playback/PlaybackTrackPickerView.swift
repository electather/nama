import SwiftUI

struct PlaybackTrackPickerView: View {
  private enum FocusTarget: Hashable {
    case subtitlesOff
    case track(String)
  }
  #if os(macOS)
    private static let minimumMacWidth: CGFloat = 360
    private static let minimumMacHeight: CGFloat = 300
  #endif

  @Environment(\.dismiss) private var dismiss
  @FocusState private var focus: FocusTarget?

  let player: NamaPlayer
  let picker: PlaybackTrackPicker

  var body: some View {
    NavigationStack {
      List {
        switch picker {
        case .audio:
          ForEach(player.audioTracks) { track in
            audioTrackButton(track)
          }

        case .subtitles:
          subtitleOffButton
          ForEach(player.subtitleTracks) { track in
            subtitleTrackButton(track)
          }
        }
      }
      .navigationTitle(picker == .audio ? "Audio" : "Subtitles")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") {
            dismiss()
          }
        }
      }
      .defaultFocus($focus, preferredFocus)
    }
    #if os(macOS)
      .frame(
        minWidth: Self.minimumMacWidth,
        minHeight: Self.minimumMacHeight
      )
    #endif
  }

  private func audioTrackButton(_ track: NamaPlaybackAudioTrack) -> some View {
    let isSelected = player.selectedAudioTrackID == track.id
    return Button {
      player.selectAudioTrack(id: track.id)
      dismiss()
    } label: {
      PlaybackTrackLabel(
        label: track.label,
        language: track.language,
        isSelected: isSelected
      )
    }
    .focused($focus, equals: .track(track.id))
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private var subtitleOffButton: some View {
    let isSelected = player.selectedSubtitleTrackID == nil
    return Button {
      player.disableSubtitles()
      dismiss()
    } label: {
      PlaybackTrackLabel(label: "Off", language: nil, isSelected: isSelected)
    }
    .focused($focus, equals: .subtitlesOff)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private func subtitleTrackButton(_ track: NamaPlaybackSubtitleTrack) -> some View {
    let isSelected = player.selectedSubtitleTrackID == track.id
    return Button {
      player.selectSubtitleTrack(id: track.id)
      dismiss()
    } label: {
      PlaybackTrackLabel(
        label: track.label,
        language: track.language,
        isSelected: isSelected
      )
    }
    .focused($focus, equals: .track(track.id))
    .accessibilityAddTraits(isSelected ? .isSelected : [])
  }

  private var preferredFocus: FocusTarget? {
    switch picker {
    case .audio:
      player.selectedAudioTrackID.map(FocusTarget.track)
        ?? player.audioTracks.first.map { .track($0.id) }

    case .subtitles:
      player.selectedSubtitleTrackID.map(FocusTarget.track) ?? .subtitlesOff
    }
  }
}

private struct PlaybackTrackLabel: View {
  let label: String
  let language: String?
  let isSelected: Bool

  var body: some View {
    HStack {
      VStack(alignment: .leading) {
        Text(label)
        if let language {
          Text(language)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      if isSelected {
        Image(systemName: "checkmark")
          .accessibilityHidden(true)
      }
    }
    .contentShape(.rect)
  }
}
