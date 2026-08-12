import XCTest

#if canImport(Nama)
  @testable import Nama
#endif

final class PlaybackLifecycleTests: XCTestCase {
  func testOnlyNewestLoadGenerationCanPublish() {
    var fence = PlaybackLoadFence()

    let replaced = fence.begin()
    let current = fence.begin()

    XCTAssertFalse(fence.isCurrent(replaced))
    XCTAssertTrue(fence.isCurrent(current))
  }

  func testNavigationCancellationInvalidatesCurrentLoad() {
    var fence = PlaybackLoadFence()
    let leavingPlayer = fence.begin()

    fence.invalidate()

    XCTAssertFalse(fence.isCurrent(leavingPlayer))
  }
}
