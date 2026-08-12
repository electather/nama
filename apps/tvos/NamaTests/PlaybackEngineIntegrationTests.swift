import AetherEngine
import CoreGraphics
import Foundation
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

  func testMapsTextSubtitleCue() {
    let cue = SubtitleCue(
      id: 7,
      startTime: 1.25,
      endTime: 3.5,
      body: .text("Hello"),
      placement: SubtitleTextPlacement(alignment: 5, position: CGPoint(x: 0.5, y: 0.25))
    )

    let mapped = AetherPlaybackMapping.subtitleCue(cue)

    XCTAssertEqual(mapped.id, "7")
    XCTAssertEqual(mapped.startTime, 1.25)
    XCTAssertEqual(mapped.endTime, 3.5)
    XCTAssertEqual(mapped.textPlacement, CGPoint(x: 0.5, y: 0.25))
    XCTAssertFalse(mapped.isForced)
    guard case .text(let text) = mapped.body else {
      return XCTFail("Expected a text cue")
    }
    XCTAssertEqual(text, "Hello")
  }

  func testFlattensRichSubtitleCueRunsToText() {
    let cue = SubtitleCue(
      id: 8,
      startTime: 0,
      endTime: 2,
      body: .richText([
        SubtitleTextRun(text: "Hello ", color: nil, isBold: true),
        SubtitleTextRun(text: "world", color: nil, isItalic: true),
      ])
    )

    let mapped = AetherPlaybackMapping.subtitleCue(cue)

    guard case .text(let text) = mapped.body else {
      return XCTFail("Expected rich runs to map to text")
    }
    XCTAssertEqual(text, "Hello world")
  }

  func testMapsImageSubtitleCueGeometryAndForcedFlag() {
    let image = onePixelImage()
    let position = CGRect(x: 0.1, y: 0.7, width: 0.8, height: 0.2)
    let canvasSize = CGSize(width: 1920, height: 1080)
    let cue = SubtitleCue(
      id: 9,
      startTime: 4,
      endTime: 6,
      body: .image(
        SubtitleImage(
          cgImage: image,
          position: position,
          canvasSize: canvasSize,
          isForced: true
        ))
    )

    let mapped = AetherPlaybackMapping.subtitleCue(cue)

    XCTAssertTrue(mapped.isForced)
    guard
      case .image(
        let mappedImage,
        let mappedPosition,
        let mappedCanvasSize
      ) = mapped.body
    else {
      return XCTFail("Expected an image cue")
    }
    XCTAssertEqual(mappedImage.width, 1)
    XCTAssertEqual(mappedImage.height, 1)
    XCTAssertEqual(mappedPosition, position)
    XCTAssertEqual(mappedCanvasSize, canvasSize)
  }

  func testClassifiesTypedEngineErrorsWithoutLeakingDetails() {
    let cases: [(any Error, PlaybackFailureCategory, String)] = [
      (URLError(.timedOut), .network, "The media source could not be reached."),
      (AetherEngineError.noVideoStream, .unsupportedMedia, "This media format is not supported."),
      (
        HLSVideoEngine.HLSVideoEngineError.unsupportedCodec(rawCodecID: 42),
        .unsupportedMedia,
        "This media format is not supported."
      ),
      (
        HLSIngestError.playlistUnreachable(status: 401),
        .network,
        "The media source could not be reached."
      ),
      (
        HLSIngestError.playlistInvalid(reason: "token=secret"),
        .playbackUnavailable,
        "Playback is temporarily unavailable."
      ),
    ]

    for (error, category, summary) in cases {
      XCTAssertEqual(
        AetherPlaybackMapping.failure(error),
        PlaybackFailure(category: category, summary: summary, recoveryAction: .retry)
      )
    }
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

  private func onePixelImage() -> CGImage {
    let provider = CGDataProvider(data: Data([255, 255, 255, 255]) as CFData)!
    return CGImage(
      width: 1,
      height: 1,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    )!
  }
}
