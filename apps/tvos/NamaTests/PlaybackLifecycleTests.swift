import CoreGraphics
import XCTest

#if canImport(Nama)
  @testable import Nama
#endif

final class PlaybackLifecycleTests: XCTestCase {
  func testLoadingSuppressesEngineObservations() {
    var gate = PlaybackLifecycleGate()

    _ = gate.beginLoad()

    XCTAssertFalse(gate.acceptsEngineObservations)
  }

  func testActiveSessionAcceptsEngineObservationsAfterCurrentLoadCompletes() {
    var gate = PlaybackLifecycleGate()
    let current = gate.beginLoad()

    XCTAssertTrue(gate.finishLoad(for: current))
    XCTAssertTrue(gate.acceptsEngineObservations)
  }

  func testNoRequestRejectsEngineObservations() {
    var gate = PlaybackLifecycleGate()

    XCTAssertFalse(gate.acceptsEngineObservations)
  }

  func testNavigationRejectsObservationsAndStaleCompletion() {
    var gate = PlaybackLifecycleGate()

    let stale = gate.beginLoad()

    gate.cancel()

    XCTAssertFalse(gate.permitsTerminalPublication(for: stale))
    XCTAssertFalse(gate.acceptsEngineObservations)
    XCTAssertFalse(gate.finishLoad(for: stale))
  }

  func testCurrentLoadCompletionPermitsTaskCleanup() {
    var gate = PlaybackLifecycleGate()
    let current = gate.beginLoad()

    XCTAssertTrue(gate.permitsTerminalPublication(for: current))
    XCTAssertTrue(gate.finishLoad(for: current))
  }

  func testStaleLoadCompletionCannotClearCurrentTask() {
    var gate = PlaybackLifecycleGate()
    let stale = gate.beginLoad()
    _ = gate.beginLoad()

    XCTAssertFalse(gate.permitsTerminalPublication(for: stale))
    XCTAssertFalse(gate.finishLoad(for: stale))
    XCTAssertFalse(gate.acceptsEngineObservations)
  }

  func testSeekButtonsClampToPlayableRange() {
    let clock = PlaybackClockState(currentTime: 5, duration: 100, seekTarget: nil)

    XCTAssertEqual(clock.seekTarget(offsetBy: -10), 0)
    XCTAssertEqual(clock.seekTarget(offsetBy: 10), 15)
    XCTAssertEqual(
      PlaybackClockState(currentTime: 98, duration: 100, seekTarget: nil)
        .seekTarget(offsetBy: 10),
      100
    )
  }

  func testAspectFitRectLetterboxesWideVideo() {
    let rect = PlaybackPresentationGeometry.aspectFitRect(
      presentationSize: CGSize(width: 1_920, height: 1_080),
      in: CGRect(x: 0, y: 0, width: 1_200, height: 900)
    )

    XCTAssertEqual(rect, CGRect(x: 0, y: 112.5, width: 1_200, height: 675))
  }

  func testAspectFitRectPillarboxesNarrowVideo() {
    let rect = PlaybackPresentationGeometry.aspectFitRect(
      presentationSize: CGSize(width: 1_440, height: 1_080),
      in: CGRect(x: 0, y: 0, width: 1_920, height: 1_080)
    )

    XCTAssertEqual(rect, CGRect(x: 240, y: 0, width: 1_440, height: 1_080))
  }

  func testMapsImageSubtitleCanvasInsideOffsetVideoRect() {
    let rect = PlaybackSubtitleGeometry.imageRect(
      position: CGRect(x: 0.1, y: 0.7, width: 0.8, height: 0.2),
      canvasSize: CGSize(width: 1_920, height: 2_160),
      contentRect: CGRect(x: 100, y: 50, width: 800, height: 450)
    )

    XCTAssertEqual(rect, CGRect(x: 180, y: 455, width: 640, height: 180))
  }

  func testTextPlacementPreservesEveryASSAnchor() {
    let expected:
      [(
        Int, PlaybackSubtitleHorizontalAnchor, PlaybackSubtitleVerticalAnchor,
        CGSize
      )] = [
        (1, .leading, .bottom, CGSize(width: 200, height: -100)),
        (2, .center, .bottom, CGSize(width: -200, height: -100)),
        (3, .trailing, .bottom, CGSize(width: -600, height: -100)),
        (4, .leading, .center, CGSize(width: 200, height: 100)),
        (5, .center, .center, CGSize(width: -200, height: 100)),
        (6, .trailing, .center, CGSize(width: -600, height: 100)),
        (7, .leading, .top, CGSize(width: 200, height: 300)),
        (8, .center, .top, CGSize(width: -200, height: 300)),
        (9, .trailing, .top, CGSize(width: -600, height: 300)),
      ]
    let contentRect = CGRect(x: 100, y: 50, width: 800, height: 400)

    for (alignment, horizontal, vertical, offset) in expected {
      let layout = PlaybackSubtitleGeometry.textLayout(
        placement: PlaybackSubtitleTextPlacement(
          alignment: alignment,
          position: CGPoint(x: 0.25, y: 0.75)
        ),
        contentRect: contentRect
      )

      XCTAssertEqual(layout.point, CGPoint(x: 300, y: 350))
      XCTAssertEqual(layout.horizontalAnchor, horizontal)
      XCTAssertEqual(layout.verticalAnchor, vertical)
      XCTAssertEqual(layout.offset(in: contentRect), offset)
    }
  }

  func testDefaultTextPlacementUsesBottomCenterOfVideoRect() {
    let layout = PlaybackSubtitleGeometry.textLayout(
      placement: nil,
      contentRect: CGRect(x: 100, y: 50, width: 800, height: 400)
    )

    XCTAssertEqual(layout.point, CGPoint(x: 500, y: 418))
    XCTAssertEqual(layout.horizontalAnchor, .center)
    XCTAssertEqual(layout.verticalAnchor, .bottom)
  }
}
