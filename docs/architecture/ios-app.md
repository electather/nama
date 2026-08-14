# iOS application

Status: the disposable tvOS playback experiment passed as a feasibility study
and was retired on 2026-08-14. No universal Apple application is currently
checked in.

## Decision

The experiment established the durable client and playback boundaries without
depending on the unfinished core or Jellyfin plugin. Its implementation,
fixtures, mock server, tests, Xcode project, and dependency lock were test
artifacts rather than a product foundation, so they were removed after the
findings below were recorded.

“Passed” means the spike answered its architecture questions. It does not mean
the simulator proved physical display switching, hardware decoding, speaker
behavior, distribution readiness, or production stability. Those remain
acceptance gates for the next implementation.

AetherEngine `6.21.0` is not eligible for Nama: exact-source review and the lab
showed public Release logging of complete locator URLs and cross-origin replay
of unrecognized custom headers. Source review of Sodalite's newer AetherEngine
integration confirmed broad playback machinery but the same trust-boundary
failures. Sodalite's GPL application code is design evidence, not source to
copy. A future implementation may clean-room reproduce useful behavior only
after selecting a secure, reviewed engine revision or fork.

## Durable application boundary

- The first client is one universal native Swift/SwiftUI application rooted in
  `apps/ios`, targeting iOS 17+, tvOS 17+, and macOS 14+. Use Observation and
  structured concurrency before adding a state or dependency framework.
- Keep one multiplatform application target and a small composition root.
  Construct concrete dependencies at the root and pass them to feature owners;
  do not add a service locator, global mutable registry, or app-wide view model.
- Share feature behavior and Nama-owned models across platforms. Add
  platform-specific presentation or system adapters only where input, focus,
  navigation, lifecycle, storage, or media APIs actually differ.
- Organize source by feature ownership. Pairing, Home, Library, Details, and
  Playback own their behavior instead of sharing global Views, Models,
  Services, or ViewModels layers.
- Generated `api.v1` values stop at the networking edge. Features map them
  into Nama-owned models before presentation.
- Create a feature or abstraction only when its behavior exists. Do not reserve
  empty packages or add a multi-engine factory before a second engine proves
  the shared interface.

## Playback boundary

Playback has one concrete, Nama-owned adapter. It is the only code allowed to
import the selected engine. Engine views, publishers, tracks, cues, errors, and
configuration types never cross into another feature or the public RPC layer.

The adapter exposes Nama-owned values:

- a request with a short-lived media locator, origin-scoped headers, allowed
  redirect origins, MIME information, resume position, and external subtitle
  locators;
- stable playback state, separate high-frequency clock state, opaque audio and
  subtitle tracks, detected video characteristics, and sanitized failures; and
- load, stop, play, pause, seek, audio-selection, and subtitle-selection
  operations.

Keep the clock separate from stable state and track lists so ticks do not
invalidate focused controls. One load owns one task: a newer load cancels and
stops the previous session, leaving playback stops it, and replacement
cancellation is not a user-visible failure. Native and software rendering
surfaces may switch internally, but the adapter remains the sole lifecycle
owner.

## Locator and logging invariants

Media travels directly from the provider to the client. The core is not a media
relay, and an on-device loopback bridge used by a player does not change that
boundary.

- Locators and locator headers are session-memory-only. Never persist or place
  them in logs, errors, analytics, diagnostics, metadata, defaults, or Keychain.
- Custom locator headers apply only to the locator's exact normalized
  scheme/host/effective-port origin. A redirect never widens that scope.
- Enforce the same rule independently for every HLS playlist, variant,
  rendition, segment, key, subtitle, and redirect request.
- Follow only origins present in the validated `allowed_redirect_origins`
  allowlist, without forwarding origin-scoped headers to a changed origin.
- Normalize engine and network failures into a closed, secret-free Nama error
  model.

An engine that cannot enforce these rules internally is ineligible. Removing
all headers, marking secrets private after interpolation, or sanitizing only at
the app boundary is not an acceptable workaround.

## Player interaction findings

- Critical controls are visible, focusable, and labelled; no required action
  exists only as an undiscoverable remote gesture.
- Back/Menu stops playback before leaving the player. Loading and failure states
  remain actionable.
- Audio and subtitle selection use an explicit focus-stable tvOS surface.
  SwiftUI `Menu` produced context-menu and focus failures even though the engine
  discovered both audio tracks.
- Clamp displayed position and seek targets to the known duration. Engines may
  report a final clock beyond duration.
- Treat source dynamic range and actual output dynamic range as separate facts.
  Detected HDR or Dolby Vision metadata does not prove display-mode switching.
- Keep fixture IDs and diagnostics out of the product playback model. Product
  diagnostics remain allowlisted and never display locators or headers.

## Future acceptance

Before product playback work depends on an engine:

1. Pin and inspect the exact source revision, including redirect, HLS
   subrequest, logging, error, and locator-refresh behavior on iOS, tvOS, and
   macOS.
2. Keep engine imports confined to the adapter and test Nama-owned mapping,
   lifecycle, track-selection, platform interaction, and redaction behavior.
3. Exercise SDR, HDR10, Dolby Vision, multichannel audio, text and image
   subtitles, seeking, track switching, redirects, expiry, and recovery on
   representative physical iPhone or iPad, Apple TV, and Mac hardware. Display
   switching and home-theater audio claims require the actual Apple TV,
   display, and audio route.
4. Verify Release logs and network captures contain no locator, query secret,
   header, or cross-origin credential replay on every supported platform.
5. Inspect the signed artifacts, linkage, bundled media libraries, notices,
   corresponding source, and relinking obligations before distribution.

Simulator builds and source comments are evidence, not physical-device proof.
Generated Swift bindings remain committed for the future client, but they do
not prove that an iOS, tvOS, or macOS application compiles or runs while no
universal app exists.
