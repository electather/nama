# iOS application

Status: the universal Apple application and its first manual-connection tracer
are implemented; LAN discovery, verified-endpoint persistence, pairing, and
media behavior remain target work.

## Target application boundary

[ADR-0011](../adr/0011-universal-native-apple-application.md) establishes the
one universal application target. Its boundary is:

- The first client is one universal native Swift/SwiftUI application rooted in
  `apps/ios`, targeting iOS 26+, tvOS 26+, and macOS 26+ under
  [ADR-0029](../adr/0029-apple-platform-26-minimum.md). Use Observation and
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

The checked-in baseline normalizes manual HTTP(S) endpoints, verifies them
through one cancellable ten-second `SetupService.GetStatus` request at the
generated-client networking edge, and presents ready, setup-required,
Nama-unavailable, transport/TLS/timeout, and incompatible states without raw
failure detail. iOS, iPadOS, and macOS use the shared native form presentation;
tvOS uses a focus-specific scrolling presentation over the same feature state.
The macOS target enables App Sandbox with outgoing network-client access only,
and `check:ios` runs Swift Testing plus signing-disabled iOS, tvOS, and macOS
builds.

## Connection boundary

The initial connection feature treats a Nama endpoint as a transport address,
not deployment identity. A canonical endpoint is an absolute HTTP or HTTPS URL
with an explicit scheme and non-empty host, no credentials, query, or fragment,
and an optional reverse-proxy path prefix. Changing endpoints requires fresh
verification and, once pairing exists, fresh pairing; a credential is never
replayed to another endpoint based on a name or similar response.

LAN discovery uses Network framework `NWBrowser` for `_nama._tcp`. A browse
result is usable only when its TXT record contains one structurally valid `url`
value. The service instance name is untrusted secondary display text, unknown
TXT keys are ignored, and results sharing one normalized URL are one candidate.
Browsing starts only after an explicit user action. Discovery never contacts a
candidate or automatically selects a sole result; selecting a result and
submitting a manual URL enter the same verification path.

Verification makes one cancellable, ten-second
`SetupService.GetStatus` call with platform TLS trust and no certificate
bypass. `initialized=true` means the endpoint is ready for pairing;
`initialized=false` is a verified endpoint that requires Administrator setup.
Nama availability failures, transport failures, and incompatible responses
remain distinct safe states without raw URLSession, TLS, or response detail.
Issue #34 owns every plain-HTTP exception and warning.

Only a verified canonical endpoint is stored in `UserDefaults`. Service names,
TXT data, transient status, failed input, and errors are not persisted. Launch
re-verifies the stored endpoint once without deleting it on an offline failure.
Device credentials remain future Keychain state owned by pairing.

The application declares `_nama._tcp` in `NSBonjourServices` and explains
local-network access through `NSLocalNetworkUsageDescription`; browsing this
one declared service does not add the multicast entitlement. iOS, iPadOS, and
macOS expose local-network permission while tvOS does not. The connection
surface keeps manual entry available, stops browsing outside the foreground,
and uses a focus-specific tvOS presentation over the shared feature state. It
ends in an honest ready, setup-required, or retryable status rather than a
placeholder pairing or Home flow.

## Connection acceptance

One Swift Testing target owns endpoint normalization, TXT parsing, candidate
reconciliation, cancellation, safe failure mapping, state transitions, and
persistence behavior. The native check builds the shared scheme for iOS, tvOS,
and macOS.

Runtime acceptance remains explicit:

- LAN discovery runs on a physical iPhone, physical iPad, Apple TV, and Mac;
- manual LAN, VPN, and reverse-proxy entry runs on all four surfaces;
- local-network allow, deny, and later-settings-change behavior runs on
  physical iPhone, physical iPad, and Mac; and
- an unrun physical-device row remains unverified. Simulator behavior is not
  local-network privacy proof.

## Playback boundary

[ADR-0012](../adr/0012-single-playback-engine-adapter.md) confines the
selected engine to this adapter.


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

[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md) establishes the
direct-delivery security boundary.

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
Generated Swift bindings are consumed by the universal application, but
generated code and generic builds do not prove physical-device runtime
behavior.
