import AetherEngine
import XCTest
@testable import Nama

final class PlaybackEngineIntegrationTests: XCTestCase {
  func testMapsEveryStableEngineStateWithoutLeakingErrorText() {
    let states: [(AetherEngine.PlaybackState, Nama.PlaybackState)] = [
      (.idle, .idle),
      (.loading, .loading),
      (.playing, .playing),
      (.paused, .paused),
      (.seeking, .seeking),
      (.ended, .ended),
      (
        .error("Authorization: secret at http://media.local/private"),
        .failed(
          PlaybackFailure(
            category: .unknown,
            summary: "Playback could not continue.",
            recoveryAction: .retry
          ))
      ),
    ]

    for (engineState, expected) in states {
      XCTAssertEqual(AetherPlaybackMapping.state(engineState), expected)
    }
  }

  func testMapsTrackPresentationWithoutExposingEngineIdentifiers() {
    let track = TrackInfo(
      id: 12,
      name: "English Commentary",
      codec: "eac3",
      language: "eng",
      channels: 6,
      bitrate: 640_000,
      isDefault: true,
      isCommentary: true,
      isAtmos: true
    )

    XCTAssertEqual(
      AetherPlaybackMapping.audioTrack(track),
      PlaybackAudioTrack(
        id: "12",
        label: "English Commentary",
        language: "eng",
        codec: "eac3",
        channelCount: 6,
        isDefault: true,
        isCommentary: true,
        isAtmos: true
      ))
  }

  func testClassifiesTextAndImageSubtitleTracks() {
    let text = TrackInfo(
      id: 4,
      name: "English",
      codec: "subrip",
      language: "eng",
      isDefault: false
    )
    let image = TrackInfo(
      id: 5,
      name: "Signs",
      codec: "hdmv_pgs_subtitle",
      language: "eng",
      isDefault: false,
      isForced: true
    )

    XCTAssertEqual(AetherPlaybackMapping.subtitleTrack(text).representation, .text)
    XCTAssertEqual(AetherPlaybackMapping.subtitleTrack(image).representation, .image)
  }

  func testMapsSourceProbeWithoutRetainingItsURL() {
    let probe = SourceProbe(
      url: URL(string: "http://user:secret@media.local/private.mkv")!,
      durationSeconds: 120,
      videoFormat: .dolbyVision,
      videoCodecID: 173,
      videoCodecName: "hevc",
      videoWidth: 3840,
      videoHeight: 2160,
      videoFrameRate: 23.976,
      isDolbyVision: true,
      dvProfile: 8,
      audioTracks: [],
      subtitleTracks: []
    )

    XCTAssertEqual(
      AetherPlaybackMapping.videoDiagnostics(
        probe: probe,
        container: "matroska",
        outputDynamicRange: .hdr10
      ),
      PlaybackVideoDiagnostics(
        container: "matroska",
        codec: "hevc",
        width: 3840,
        height: 2160,
        frameRate: 23.976,
        sourceDynamicRange: .dolbyVision,
        outputDynamicRange: .hdr10,
        dolbyVisionProfile: 8
      ))
  }

  func testSanitizesUnderlyingErrors() {
    let sensitive = NSError(
      domain: "http://media.local/private",
      code: 401,
      userInfo: [NSLocalizedDescriptionKey: "Authorization: Bearer secret-token"]
    )

    XCTAssertEqual(
      AetherPlaybackMapping.failure(sensitive),
      PlaybackFailure(
        category: .unknown,
        summary: "Playback could not continue.",
        recoveryAction: .retry
      ))
  }
}
