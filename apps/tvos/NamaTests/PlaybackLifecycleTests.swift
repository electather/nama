import CoreGraphics
import XCTest

#if canImport(Nama)
  @testable import Nama
#endif

final class PlaybackLifecycleTests: XCTestCase {
  func testCurrentLoadCanPublishTerminalState() {
    var fence = PlaybackLoadFence()

    let current = fence.begin()

    XCTAssertTrue(fence.permitsTerminalPublication(for: current))
  }

  func testReplacedLoadCannotPublishTerminalState() {
    var fence = PlaybackLoadFence()
    let stale = fence.begin()
    _ = fence.begin()

    XCTAssertFalse(fence.permitsTerminalPublication(for: stale))
  }

  func testNavigationCancellationCannotPublishTerminalState() {
    var fence = PlaybackLoadFence()
    let stale = fence.begin()

    fence.invalidate()

    XCTAssertFalse(fence.permitsTerminalPublication(for: stale))
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
