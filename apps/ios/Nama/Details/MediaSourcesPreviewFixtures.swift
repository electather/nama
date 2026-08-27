#if DEBUG
  import SwiftUI

  private enum MediaSourcesPreviewFixtures {
    static let audioChannelCount: UInt32 = 8
    static let audioTrackOrder: UInt32 = 1
    static let bitDepth: UInt32 = 10
    static let bitRateBps: UInt64 = 18_500_000
    static let frameRate = 23.976
    static let fullHDAudioChannelCount: UInt32 = 2
    static let fullHDHeight: UInt32 = 1_080
    static let fullHDWidth: UInt32 = 1_920
    static let partOrder: UInt32 = 0
    static let runtimeSeconds: Int64 = 7_205
    static let sampleRateHz: UInt32 = 48_000
    static let sizeBytes: UInt64 = 16_000_000_000
    static let subtitleTrackOrder: UInt32 = 2
    static let ultraHDHeight: UInt32 = 2_160
    static let ultraHDWidth: UInt32 = 3_840
    static let videoTrackOrder: UInt32 = 0

    static let defaultSummary = MediaSourceSummary(
      identity: MediaSourceIdentity("source-default-preview"),
      label: "4K HDR",
      isDefault: true,
      availability: .available,
      container: "mkv",
      videoQuality: MediaVideoQuality(
        codec: "hevc",
        width: ultraHDWidth,
        height: ultraHDHeight,
        dynamicRange: .dolbyVision
      ),
      audioQuality: MediaAudioQuality(
        codec: "truehd",
        channelCount: audioChannelCount,
        spatialFormat: .dolbyAtmos
      )
    )
    static let unavailableSummary = MediaSourceSummary(
      identity: MediaSourceIdentity("source-unavailable-preview"),
      label: "1080p",
      isDefault: false,
      availability: .providerUnavailable,
      container: "mp4",
      videoQuality: MediaVideoQuality(
        codec: "h264",
        width: fullHDWidth,
        height: fullHDHeight,
        dynamicRange: .sdr
      ),
      audioQuality: MediaAudioQuality(
        codec: "aac",
        channelCount: fullHDAudioChannelCount,
        spatialFormat: .nonSpatial
      )
    )
    static let selection = MediaSourcesSelection(
      mediaIdentity: MediaIdentity("movie-sources-preview"),
      mediaKind: .movie,
      mediaTitle: "A Canonical Movie With Several Carefully Preserved Sources",
      sourceSummaries: [defaultSummary, unavailableSummary]
    )
    static let part = MediaPart(
      identity: MediaPartIdentity("part-preview"),
      order: partOrder,
      container: "mkv",
      runtime: .seconds(runtimeSeconds),
      sizeBytes: sizeBytes,
      bitRateBps: bitRateBps,
      tracks: [
        MediaTrack(
          order: videoTrackOrder,
          details: .video(
            MediaVideoTrack(
              codec: "hevc",
              width: ultraHDWidth,
              height: ultraHDHeight,
              frameRate: frameRate,
              bitDepth: bitDepth,
              dynamicRange: .dolbyVision
            )
          )
        ),
        MediaTrack(
          order: audioTrackOrder,
          details: .audio(
            MediaAudioTrack(
              codec: "truehd",
              title: "Main mix",
              language: "eng",
              channelCount: audioChannelCount,
              channelLayout: "7.1",
              sampleRateHz: sampleRateHz,
              spatialFormat: .dolbyAtmos,
              isDefault: true,
              isCommentary: false
            )
          )
        ),
        MediaTrack(
          order: subtitleTrackOrder,
          details: .subtitle(
            MediaSubtitleTrack(
              codec: "pgs",
              title: "English SDH",
              language: "eng",
              representation: .image,
              isDefault: false,
              isForced: false,
              isHearingImpaired: true,
              isCommentary: false
            )
          )
        ),
      ]
    )
    static let source = MediaSource(
      identity: defaultSummary.identity,
      mediaIdentity: selection.mediaIdentity,
      label: defaultSummary.label,
      availability: .available,
      runtime: .seconds(runtimeSeconds),
      bitRateBps: bitRateBps,
      parts: [part]
    )

    static let noAction: @MainActor () -> Void = {
      // Static inspection fixtures perform no action.
    }
    static let noSourceAction: @MainActor (MediaSourceIdentity) -> Void = { _ in
      // Static inspection fixtures load no network data.
    }
    static let noAsyncAction: @MainActor () async -> Void = {
      // Static inspection fixtures own no authorization.
    }
  }

  @MainActor
  private func mediaSourcesPreview(_ state: MediaSourcesState) -> some View {
    NavigationStack {
      MediaSourcesPresentationView(
        selection: MediaSourcesPreviewFixtures.selection,
        state: state,
        inspect: MediaSourcesPreviewFixtures.noSourceAction,
        retry: MediaSourcesPreviewFixtures.noAction,
        play: MediaSourcesPreviewFixtures.noAction,
        reauthorize: MediaSourcesPreviewFixtures.noAsyncAction
      )
      .navigationTitle("Sources")
    }
  }

  #Preview("Sources — Choosing") {
    mediaSourcesPreview(.choosing(MediaSourcesPreviewFixtures.selection))
  }

  #Preview("Sources — Technical details") {
    mediaSourcesPreview(
      .inspected(
        MediaSourcesPreviewFixtures.selection,
        MediaSourcesPreviewFixtures.defaultSummary,
        MediaSourcesPreviewFixtures.source
      )
    )
  }

  #Preview("Sources — Unavailable") {
    mediaSourcesPreview(
      .inspected(
        MediaSourcesPreviewFixtures.selection,
        MediaSourcesPreviewFixtures.unavailableSummary,
        MediaSource(
          identity: MediaSourcesPreviewFixtures.unavailableSummary.identity,
          mediaIdentity: MediaSourcesPreviewFixtures.selection.mediaIdentity,
          label: MediaSourcesPreviewFixtures.unavailableSummary.label,
          availability: .providerUnavailable,
          runtime: nil,
          bitRateBps: nil,
          parts: []
        )
      )
    )
  }

  #Preview("Sources — Stale response") {
    mediaSourcesPreview(
      .failed(
        MediaSourcesPreviewFixtures.selection,
        MediaSourcesPreviewFixtures.defaultSummary,
        .stale
      )
    )
  }
#endif
