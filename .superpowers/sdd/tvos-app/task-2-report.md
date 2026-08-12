# Task 2 report: engine-backed player

## Implementation

- Added the concrete `@MainActor` Observation-backed `NamaPlayer`, owning one
  `AetherEngine`, with replacement/navigation cancellation and a generation
  fence.
- Added the engine surface and a Nama-owned full-screen player UI: transport,
  scrubber, audio/subtitle menus (including Off), subtitle cues, diagnostics,
  retry, and caller-provided fixture navigation.
- Kept the high-frequency clock separate from stable player state and added the
  pure `PlaybackLoadFence` lifecycle assertions.
- Registered the new source and test files in the existing tvOS target.

## TDD evidence

RED: this checkout already contained the Task 2 implementation and its staged
`PlaybackLoadFence` test when this finishing pass began. No pre-implementation
failing test run is available, so RED cannot be claimed retrospectively.

GREEN available evidence: `PlaybackLifecycleTests.swift` asserts that a
replacement generation cannot publish and that navigation invalidates the
current generation. The focused Swift typecheck/run could not execute because
the local Command Line Tools SDK and Swift compiler are version-mismatched; the
pinned Xcode 26.6 app required by this repository is absent.

## Verification

| Command | Result |
| --- | --- |
| `SWIFT_MODULECACHE_PATH=/private/tmp/nama-swift-module-cache swift format lint --strict --recursive apps/tvos` | passed |
| `swiftc -parse ...PlaybackModels.swift ...NamaPlayer.swift ...NamaPlayerSurface.swift ...PlayerScreen.swift ...PlaybackLifecycleTests.swift` | passed |
| `plutil -lint apps/tvos/Nama.xcodeproj/project.pbxproj` | passed |
| Aether import boundary check | passed: imports/types are limited to Playback integration files and the existing integration test |
| diagnostics URL/credential source check | passed for `PlayerScreen.swift` |
| `git diff --cached --check` | passed |
| `swiftc -typecheck apps/tvos/Nama/Playback/PlaybackModels.swift apps/tvos/NamaTests/PlaybackLifecycleTests.swift` | blocked: Swift 6.3.3 compiler versus SDK Swift 6.3.2 mismatch; initially also required a writable module cache |
| tvOS `xcodebuild` / XCTest | blocked: `/Applications/Xcode_26.6.app` is not installed; active developer directory is CommandLineTools |

## Self-review and concerns

- The app-level Aether API calls and runtime lifecycle remain uncompiled and
  untested until the pinned Xcode is installed; physical-device verification is
  still required by the approved design.
- `allowedRedirectOrigins` are retained only as advisory request diagnostics,
  consistent with the approved known Aether limitation. No locator URL, HTTP
  header, or credential value is rendered in diagnostics.

## Fix Round 1

- The lifecycle fence now gates the actual terminal success/failure publication.
  A load task clears itself only when it still owns that generation; engine
  observations are ignored while a load is in flight and are snapshotted only
  after the authoritative load completes. Replacement and navigation therefore
  cannot clear a newer task or repopulate the reset UI with stale observations.
- Image subtitle layout is now a pure canvas-to-display helper. It follows
  Aether 6.21's normalized-coordinate contract: width-aligned with a
  vertically center-anchored pixel canvas.
- Play on an ended item reloads the retained request. Failed playback retains
  the diagnostics toggle. `PlayerScreenBoundary` is the concrete `try
  NamaPlayer()` boundary and renders only the sanitized mapped failure with
  Retry and Back to Fixtures; no player protocol or factory was introduced.

### TDD and tests

- Added `PlaybackLifecycleTests` before the implementation for the real
  terminal-publication gate: current, replaced/stale, and navigation-invalidated
  generations. The same focused test file asserts a hand-derived 1920×2160
  pixel-canvas image rectangle mapped onto a 960×540 display.
- RED/GREEN XCTest execution remains unavailable locally. The test-first
  typecheck command reaches neither tests nor app sources because Command Line
  Tools does not provide `XCTest`; `/Applications/Xcode_26.6.app` is absent.
  The prior SDK/compiler mismatch is also an environment constraint for the
  pinned toolchain, so no XCTest pass or failing assertion is claimed.

### Verification

| Command | Result |
| --- | --- |
| `SWIFT_MODULECACHE_PATH=/private/tmp/nama-swift-module-cache swift format lint --strict --recursive apps/tvos` | passed |
| `swiftc -parse ...PlaybackModels.swift ...AetherPlaybackMapping.swift ...NamaPlayer.swift ...NamaPlayerSurface.swift ...PlayerScreen.swift ...PlaybackLifecycleTests.swift ...PlaybackEngineIntegrationTests.swift` | passed |
| `plutil -lint apps/tvos/Nama.xcodeproj/project.pbxproj` | passed |
| Aether import/type boundary check | passed: only Playback integration files and the existing integration test mention AetherEngine |
| diagnostics URL/credential source check | passed for `PlayerScreen.swift` |
| `git diff --check` | passed |
| `SWIFT_MODULECACHE_PATH=/private/tmp/nama-swift-module-cache CLANG_MODULE_CACHE_PATH=/private/tmp/nama-clang-module-cache swiftc -typecheck ...PlaybackLifecycleTests.swift` | blocked: `no such module 'XCTest'` under Command Line Tools |
| tvOS `xcodebuild` / XCTest | blocked: `/Applications/Xcode_26.6.app` is not installed; active developer directory is CommandLineTools |
