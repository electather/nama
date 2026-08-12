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

  func testMapsImageSubtitlePixelCanvasToScreenGeometry() {
    let rect = PlaybackSubtitleGeometry.imageRect(
      position: CGRect(x: 0.1, y: 0.7, width: 0.8, height: 0.2),
      canvasSize: CGSize(width: 1_920, height: 2_160),
      displaySize: CGSize(width: 960, height: 540)
    )

    XCTAssertEqual(rect, CGRect(x: 96, y: 486, width: 768, height: 216))
  }
}
