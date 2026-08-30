import SwiftUI

struct MediaSourceSummaryView: View {
  let title: String
  let summary: MediaSourceSummary
  let availability: MediaSourceAvailability

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Text(title)
        .font(.headline)
      MediaSourceAvailabilityView(availability: availability)
      if let container = summary.container {
        LabeledContent("Container", value: container)
      }
      if let videoQuality = summary.videoQuality {
        MediaVideoQualityView(quality: videoQuality)
      }
      if let audioQuality = summary.audioQuality {
        MediaAudioQualityView(quality: audioQuality)
      }
    }
    .multilineTextAlignment(.leading)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct MediaSourceTechnicalView: View {
  let title: String
  let summary: MediaSourceSummary
  let source: MediaSource
  let play: @MainActor () -> Void
  let retry: @MainActor () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.sectionSpacing) {
      MediaSourceAggregateView(title: title, summary: summary, source: source)
      ForEach(source.parts, id: \.identity) { part in
        MediaPartTechnicalView(part: part)
      }
      MediaSourcePlaybackActionView(
        availability: source.availability,
        play: play,
        retry: retry
      )
    }
  }
}

private struct MediaSourceAggregateView: View {
  let title: String
  let summary: MediaSourceSummary
  let source: MediaSource

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Text("Source Details")
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      MediaSourceSummaryView(
        title: title,
        summary: summary,
        availability: source.availability
      )
      if let runtime = source.runtime {
        LabeledContent("Runtime") {
          Text(runtime, format: .time(pattern: .hourMinuteSecond))
        }
      }
      if let bitRateBps = source.bitRateBps {
        LabeledContent("Bit rate") {
          Text("\(bitRateBps, format: .number.notation(.compactName)) bps")
        }
      }
    }
  }
}

private struct MediaSourcePlaybackActionView: View {
  #if os(tvOS)
    @FocusState private var actionFocused: Bool
  #endif

  let availability: MediaSourceAvailability
  let play: @MainActor () -> Void
  let retry: @MainActor () -> Void

  var body: some View {
    if availability == .available {
      Button("Play This Source", systemImage: "play.fill", action: play)
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)
        #if os(tvOS)
          .focused($actionFocused)
          .task {
            actionFocused = true
          }
        #endif
    } else {
      VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
        Text("This source cannot be selected for playback right now.")
          .foregroundStyle(.secondary)
        Button("Try Again", action: retry)
          .buttonStyle(.borderedProminent)
          #if os(tvOS)
            .focused($actionFocused)
            .task {
              actionFocused = true
            }
          #endif
      }
    }
  }
}

private struct MediaPartTechnicalView: View {
  private static let displayOrderOffset: Int64 = 1

  let part: MediaPart

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Text("Part \(Int64(part.order) + Self.displayOrderOffset)")
        .font(.headline)
        .accessibilityAddTraits(.isHeader)
      LabeledContent("Container", value: part.container)
      if let runtime = part.runtime {
        LabeledContent("Runtime") {
          Text(runtime, format: .time(pattern: .hourMinuteSecond))
        }
      }
      if let bitRateBps = part.bitRateBps {
        LabeledContent("Bit rate") {
          Text("\(bitRateBps, format: .number.notation(.compactName)) bps")
        }
      }
      ForEach(part.tracks, id: \.order) { track in
        MediaTrackTechnicalView(track: track)
      }
    }
    .padding()
    .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)
    .background(.quaternary, in: .rect(cornerRadius: MediaDetailsLayout.artworkCornerRadius))
  }
}

private struct MediaVideoQualityView: View {
  let quality: MediaVideoQuality

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      LabeledContent("Video codec", value: quality.codec)
      if let width = quality.width {
        LabeledContent("Video width") {
          Text(width, format: .number)
        }
      }
      if let height = quality.height {
        LabeledContent("Video height") {
          Text(height, format: .number)
        }
      }
      if let dynamicRange = quality.dynamicRange {
        LabeledContent("Dynamic range") {
          Text(mediaDynamicRangeTitle(dynamicRange))
        }
      }
    }
  }
}

private struct MediaAudioQualityView: View {
  let quality: MediaAudioQuality

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      LabeledContent("Audio codec", value: quality.codec)
      if let channelCount = quality.channelCount {
        LabeledContent("Audio channels") {
          Text(channelCount, format: .number)
        }
      }
      if let spatialFormat = quality.spatialFormat {
        LabeledContent("Spatial audio") {
          Text(mediaSpatialAudioTitle(spatialFormat))
        }
      }
    }
  }
}

private struct MediaSourceAvailabilityView: View {
  let availability: MediaSourceAvailability

  var body: some View {
    let presentation = mediaSourceAvailabilityPresentation(availability)
    Label(presentation.title, systemImage: presentation.symbol)
      .foregroundStyle(availability == .available ? .primary : .secondary)
  }
}

struct MediaSourceAvailabilityPresentation {
  let title: LocalizedStringKey
  let symbol: String
}

func mediaSourceAvailabilityPresentation(
  _ availability: MediaSourceAvailability
) -> MediaSourceAvailabilityPresentation {
  switch availability {
  case .available:
    MediaSourceAvailabilityPresentation(
      title: "Available",
      symbol: "checkmark.circle"
    )

  case .providerUnavailable:
    MediaSourceAvailabilityPresentation(
      title: "Temporarily unavailable",
      symbol: "exclamationmark.circle"
    )

  case .unsupported:
    MediaSourceAvailabilityPresentation(
      title: "Unsupported",
      symbol: "nosign"
    )

  case .unknown:
    MediaSourceAvailabilityPresentation(
      title: "Availability unknown",
      symbol: "questionmark.circle"
    )
  }
}
