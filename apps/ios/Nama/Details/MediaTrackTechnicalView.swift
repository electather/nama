import SwiftUI

struct MediaTrackTechnicalView: View {
  let track: MediaTrack

  @ViewBuilder
  var body: some View {
    switch track.details {
    case .video(let video):
      MediaVideoTrackView(video: video)

    case .audio(let audio):
      MediaAudioTrackView(audio: audio)

    case .subtitle(let subtitle):
      MediaSubtitleTrackView(subtitle: subtitle)

    case .unknown:
      Label("Unknown track", systemImage: "questionmark.circle")
        .font(.headline)
        .padding(.vertical, MediaDetailsLayout.creditDetailSpacing)
    }
  }
}

private struct MediaVideoTrackView: View {
  private static let maximumFrameRateFractionDigits = 3

  let video: MediaVideoTrack

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      Label("Video", systemImage: "film")
        .font(.headline)
      LabeledContent("Codec", value: video.codec)
      if let width = video.width {
        LabeledContent("Width") {
          Text(width, format: .number)
        }
      }
      if let height = video.height {
        LabeledContent("Height") {
          Text(height, format: .number)
        }
      }
      if let frameRate = video.frameRate {
        LabeledContent("Frame rate") {
          Text(
            "\(frameRate, format: .number.precision(.fractionLength(0...Self.maximumFrameRateFractionDigits))) fps"
          )
        }
      }
      if let bitDepth = video.bitDepth {
        LabeledContent("Bit depth") {
          Text(bitDepth, format: .number)
        }
      }
      if let dynamicRange = video.dynamicRange {
        LabeledContent("Dynamic range") {
          Text(mediaDynamicRangeTitle(dynamicRange))
        }
      }
    }
    .padding(.vertical, MediaDetailsLayout.creditDetailSpacing)
  }
}

private struct MediaAudioTrackView: View {
  let audio: MediaAudioTrack

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      Label("Audio", systemImage: "speaker.wave.2")
        .font(.headline)
      LabeledContent("Codec", value: audio.codec)
      MediaAudioTrackOptionalMetadataView(audio: audio)
      MediaTrackFlagsView(
        isDefault: audio.isDefault,
        isForced: false,
        isHearingImpaired: false,
        isCommentary: audio.isCommentary
      )
    }
    .padding(.vertical, MediaDetailsLayout.creditDetailSpacing)
  }
}

private struct MediaAudioTrackOptionalMetadataView: View {
  let audio: MediaAudioTrack

  var body: some View {
    if let title = audio.title {
      LabeledContent("Title", value: title)
    }
    if let language = audio.language {
      LabeledContent("Language", value: language)
    }
    if let channelCount = audio.channelCount {
      LabeledContent("Channels") {
        Text(channelCount, format: .number)
      }
    }
    if let channelLayout = audio.channelLayout {
      LabeledContent("Channel layout", value: channelLayout)
    }
    if let sampleRateHz = audio.sampleRateHz {
      LabeledContent("Sample rate") {
        Text("\(sampleRateHz, format: .number) Hz")
      }
    }
    if let spatialFormat = audio.spatialFormat {
      LabeledContent("Spatial audio") {
        Text(mediaSpatialAudioTitle(spatialFormat))
      }
    }
  }
}

private struct MediaSubtitleTrackView: View {
  let subtitle: MediaSubtitleTrack

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      Label("Subtitles", systemImage: "captions.bubble")
        .font(.headline)
      LabeledContent("Codec", value: subtitle.codec)
      if let title = subtitle.title {
        LabeledContent("Title", value: title)
      }
      if let language = subtitle.language {
        LabeledContent("Language", value: language)
      }
      LabeledContent("Representation") {
        Text(mediaSubtitleRepresentationTitle(subtitle.representation))
      }
      MediaTrackFlagsView(
        isDefault: subtitle.isDefault,
        isForced: subtitle.isForced,
        isHearingImpaired: subtitle.isHearingImpaired,
        isCommentary: subtitle.isCommentary
      )
    }
    .padding(.vertical, MediaDetailsLayout.creditDetailSpacing)
  }
}

private struct MediaTrackFlagsView: View {
  let isDefault: Bool
  let isForced: Bool
  let isHearingImpaired: Bool
  let isCommentary: Bool

  var body: some View {
    if isDefault || isForced || isHearingImpaired || isCommentary {
      ViewThatFits {
        HStack(spacing: MediaDetailsLayout.metadataSpacing) {
          flags
        }
        VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
          flags
        }
      }
      .font(.caption)
      .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private var flags: some View {
    if isDefault {
      Label("Default", systemImage: "checkmark.circle")
    }
    if isForced {
      Label("Forced", systemImage: "exclamationmark.circle")
    }
    if isHearingImpaired {
      Label("SDH", systemImage: "ear")
    }
    if isCommentary {
      Label("Commentary", systemImage: "person.wave.2")
    }
  }
}

func mediaDynamicRangeTitle(_ dynamicRange: MediaDynamicRange) -> LocalizedStringKey {
  switch dynamicRange {
  case .sdr:
    "SDR"

  case .hdr10:
    "HDR10"

  case .hdr10Plus:
    "HDR10+"

  case .hlg:
    "HLG"

  case .dolbyVision:
    "Dolby Vision"

  case .unknown:
    "Unknown"
  }
}

func mediaSpatialAudioTitle(
  _ spatialFormat: MediaSpatialAudioFormat
) -> LocalizedStringKey {
  switch spatialFormat {
  case .nonSpatial:
    "None"

  case .dolbyAtmos:
    "Dolby Atmos"

  case .dtsX:
    "DTS:X"

  case .unknown:
    "Unknown"
  }
}

private func mediaSubtitleRepresentationTitle(
  _ representation: MediaSubtitleRepresentation
) -> LocalizedStringKey {
  switch representation {
  case .text:
    "Text"

  case .image:
    "Image"

  case .unknown:
    "Unknown"
  }
}
