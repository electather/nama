# tvOS Player Architecture and POC Design

Status: stopped on 2026-08-12; AetherEngine `6.21.0` rejected for Nama adoption.

## Decision

Build the first Milestone 1 slice as a production-shaped tvOS application shell,
a single Nama-owned playback adapter around AetherEngine, and a Debug-only player
lab driven by LAN-hosted fixtures. The slice proves the lasting application and
player boundaries without depending on the unfinished Nama server or Jellyfin
plugin.

Use SwiftUI, Observation, and structured concurrency from Apple frameworks. Do
not add a state-management framework, a second app target, a player protocol with
one implementation, or empty scaffolding for future features.

Pin AetherEngine `6.21.0` exactly for the evaluated spike. That tag resolves to
commit `87868c1c88ca4ae613180c4cfb5d68c07dde0298`; the application lockfile is the
authoritative record of the resolved source inspected by this spike. The pin is
retained as the linked dependency and failed evidence on this branch, not as an
approved product engine.

The implementation reached the architecture stop condition during exact-source
review, before physical-device acceptance. AetherEngine `6.21.0` violates Nama's
locator header-origin and logging rules, so this design does not close the
Milestone 1 engine decision. No successor is selected; the choice has returned
to design review. Jellyfin negotiation, plugin IPC, authentication, and sync
semantics remain separate spikes.

## Goals

- Establish the tvOS feature ownership and dependency flow that later product
  work will follow.
- Keep every AetherEngine type behind one Nama-owned playback boundary.
- Exercise real media on a physical Apple TV 4K and an HDR/Dolby Vision display.
- Provide minimal production-shaped player controls rather than disposable test
  buttons.
- Make the playback matrix repeatable with a committed relative manifest and a
  dependency-free fixture server.
- Record enough technical and licensing evidence to decide whether AetherEngine
  is acceptable for the distributable application.

## Non-goals

- Nama server or Jellyfin communication, generated RPC orchestration, device
  pairing, discovery, authentication, or progress reporting.
- Production Home, Library, Details, or pairing UI.
- Playback negotiation, transcoding, automatic fallback, or a second engine.
- Picture in Picture, Now Playing integration, background recovery, animation
  polish, analytics, or result-export infrastructure.
- Committing media, machine-specific addresses, or credentials.
- Proving Atmos or surround passthrough with TV speakers.

## Application architecture

Nama remains one tvOS app target. `NamaApp` is a small composition root that
creates concrete dependencies and chooses the initial route. A normal launch
opens a minimal product shell. Under `#if DEBUG`, the launch argument
`--player-lab` opens Player Lab and `--player-lab-base-url <url>` supplies the
LAN fixture origin. Release builds do not expose the lab route.

Organize code by feature ownership rather than global `Views`, `ViewModels`,
`Services`, and `Models` layers. This slice creates only two owned areas:

- **Playback** owns app-facing playback models, `NamaPlayer`, the engine-backed
  rendering surface, controls, subtitle rendering, diagnostics, and error
  mapping.
- **Player Lab** owns the Debug-only fixture manifest, fixture list, launch
  configuration, and conversion from a fixture into a playback request.

Create future feature directories only when their behavior is implemented. The
intended boundaries are nevertheless fixed:

- **Pairing** will own server discovery/manual entry and the device-session flow.
- **Home** will own the home feed and Continue Watching presentation.
- **Library** will own browse and search.
- **Details** will own media details, seasons, episodes, and starting playback.
- **Playback** will remain the only owner of playback lifecycle and presentation.

Generated `api.v1` messages stay at the networking edge. Future features map
them into app-owned models before presentation. Details or another playback
coordinator will later map an opened `api.v1` playback session into the same
Nama-owned request Player Lab uses; server calls and progress reporting do not
belong in `NamaPlayer`.

Do not add a service locator, global mutable dependency registry, or app-wide
view model. Shared dependencies are constructed at the root and passed to the
feature that owns their use.

## Playback boundary

`NamaPlayer` is one concrete `@MainActor`, Observation-backed owner of an
AetherEngine instance. Views use it directly; there is no duplicate player view
model. If a second engine is ever introduced, extract only the interface proven
common by the two implementations.

The Playback feature exposes only Nama-owned values:

- A request containing the media locator, permitted HTTP headers, allowed
  redirect origins, MIME type, optional resume position, and external subtitle
  locators.
- Stable state: idle, loading, playing, paused, seeking, ended, or failed.
- A separate frequently updated clock containing current time, duration,
  buffered position, and seek target.
- Audio and subtitle track models containing opaque IDs plus presentation fields
  such as label, language, default/forced state, and subtitle representation.
- Video and diagnostics models containing only values the lab and future UI use.
- A sanitized failure with an app-owned category and recovery action.

A small set of engine-integration files may import AetherEngine. They construct
the engine, host `AetherPlayerSurface`, translate published engine state and
tracks, render text/image subtitle cues, and invoke transport methods. No
AetherEngine type, enum, error, or import crosses into Player Lab or another
feature.

The engine's high-frequency clock remains separate from stable state and track
lists. This prevents clock ticks from needlessly disturbing focused controls or
open track menus on tvOS.

One load owns one task. Starting a new fixture cancels the previous load, stops
the previous session, and makes the newest request authoritative. Leaving the
player stops playback. Cancellation caused by replacement or navigation is a
normal lifecycle event, not a visible failure.

## Player screen

The player is a full-screen Nama-owned surface with a lightweight focusable
overlay containing:

- play/pause;
- seek/scrub position;
- elapsed time and duration;
- audio-track selection;
- subtitle selection, including Off;
- text and image subtitle presentation; and
- a toggleable diagnostics panel.

The diagnostics panel shows stable player state, current and buffered positions,
detected container/codec where available, source and output dynamic range,
active tracks, and the latest sanitized failure. Player Lab decorates that panel
with its fixture ID; fixture concepts do not become part of `NamaPlayer`. The
panel never shows locator URLs, request headers, or credential values.

Support the Siri Remote play/pause command and ordinary visible, focusable
controls. No critical action may exist only as an undiscoverable gesture. Keep
focus stable while clock values update and while a track menu is open.

On failure, remain on the player with `Retry` and `Back to Fixtures`. Invalid
launch configuration, a malformed manifest, or an unreachable fixture produces
an actionable lab screen instead of a crash.

## Fixture manifest

Bundle one committed versioned JSON manifest with the app. It contains stable
metadata and relative paths only. The top level has `version` and `fixtures`.
Each fixture has:

- a stable `id` and display `title`;
- a relative `mediaPath`;
- zero or more relative sidecar subtitle entries with stable ID, label,
  language, MIME type, and path;
- a `headerScenario` of `none` or `dummyCredentials`, selecting fixed lab-owned
  marker headers without placing their values in the manifest; and
- expected container, video codec, dynamic range, audio characteristics, and
  subtitle representations.

Paths must be relative, must not contain credentials, and must remain inside the
fixture origin when resolved. Player Lab rejects absolute paths, traversal, URL
credentials, fragments, and a resolved origin different from the supplied base
URL. The base URL itself may use plain HTTP because this is a Debug-only trusted
LAN harness.

The initial matrix includes representative rows for:

- H.264 SDR;
- HEVC SDR;
- HEVC HDR10;
- HEVC Dolby Vision;
- MKV with selectable audio and text subtitles; and
- image subtitles.

A single media file may satisfy multiple rows. The manifest records the exact
profile and characteristics of the available sample instead of promising every
variant of a codec or format.

## LAN fixture server

Add one small Python-standard-library script local to the tvOS app. It accepts an
explicit fixture directory, bind address, and port; serves no path outside that
directory; and prints the two LAN origins needed by the Xcode launch arguments.
The operator runs it only on a trusted LAN and stops it after testing.

The server implements the media behavior the player needs rather than relying
on `python -m http.server`:

- `GET` and `HEAD` for fixture files;
- single byte-range requests with correct `206`, `Content-Range`, and
  `Content-Length` responses;
- deterministic same-origin redirects;
- deterministic cross-origin redirects through a second local port; and
- a check that reports only whether a fixed dummy credential marker arrived,
  never its value.

Reject invalid or multi-range requests rather than implementing a general media
server. Do not add TLS, authentication, upload, directory administration, or
production hardening to this disposable LAN tool.

## Redirect and header policy

`api.v1.PlaybackLocator.allowed_redirect_origins` remains represented in the
Nama-owned request. The canonical contract remains strict: every custom locator
header is scoped to the initial origin, and redirects are limited to the
validated allowlist.

Exact AetherEngine `6.21.0` source fails that contract in three independent
ways:

- `RedirectHeaderPolicy` removes only a fixed list of recognized credential
  names. It deliberately replays every unrecognized custom header when the
  origin changes. The lab's fixed `X-Nama-Player-Lab-Marker` therefore reaches
  the different-port target according to the pinned implementation.
- `credentialsAllowed` accepts every same-host HTTP-to-HTTPS redirect without
  comparing ports, retaining recognized credentials even though scheme and port
  identify a different origin. The upstream test fixes the concrete
  `http:8096` to `https:8920` behavior.
- `EngineLog` is active in Release, marks messages public in OSLog, and call
  sites interpolate complete `url.absoluteString` locator values.

The app adapter cannot intercept the engine's internal redirect requests or
redact its internal Release logging. Removing all headers before calling the
engine would instead break sources that require their scoped locator headers.
Adoption therefore requires a separately reviewed safe upstream pin or hook, or
a different engine selected in design review; no app-side sanitization is
accepted as a substitute.

The plain-HTTP two-port lab exercises the unconditional unknown-header replay.
TLS remains an explicit non-goal, so the same-host HTTP-to-HTTPS failure is
source- and upstream-test evidence rather than a device-lab observation.

## Verification

### Automated checks

Add one native tvOS unit-test target for logic Nama owns. Keep it focused on:

- manifest decoding and version rejection;
- relative path/origin validation and resolution;
- engine-to-Nama state, track, and failure mapping; and
- diagnostic redaction.

Do not create an AetherEngine protocol or fake engine solely for tests. Engine
integration is verified by compiling the app and exercising it on hardware.
The fixture-server script receives one small self-check for range responses,
path containment, redirect behavior, and credential-marker redaction.

The app must build for a tvOS simulator and the physical device configuration.

### Physical-device matrix

Keep setup instructions, the short manual checklist, results matrix, redirect
observations, and dependency review in one repository document local to
`apps/tvos`. For every fixture, record:

- exact Apple TV model/generation, tvOS version/build, display model and mode,
  and audio route;
- startup and sustained playback;
- detected container, video codec, and dynamic range;
- actual display-mode switching for SDR, HDR10, and Dolby Vision;
- play/pause, seeking, and post-seek recovery;
- discovered and selected audio/subtitle tracks;
- text/image subtitle rendering;
- multichannel decode/downmix through the TV speakers; and
- any sanitized failure signal and reproduction notes.

For this spike, repeatable means that every required row succeeds in two fresh
player sessions. Each run plays for at least five minutes or to the end of a
shorter fixture, performs one forward and one backward seek, and switches each
available audio/subtitle kind at least once. Verify HDR/Dolby Vision output from
the television's reported input mode, not only the engine's detected source
metadata.

The available hardware is an Apple TV 4K on the current installed tvOS release,
an HDR/Dolby Vision television, and television speakers. Record actual version
and model identifiers when testing rather than the word `latest`. Atmos and
surround passthrough are explicitly unverified and do not block this spike.

An unsupported fixture is documented. Its direct-stream/transcode fallback is
deferred to the separate Jellyfin-negotiation spike; it is not invented in this
client-only harness.

## Dependency and distribution review

The review records the exact application-resolved revision and the artifacts
actually linked into the tvOS build, not merely every repository SwiftPM had to
resolve. At minimum, inspect and retain evidence for:

- AetherEngine's LGPL-3.0 license and Apple Store/DRM exception;
- FFmpegBuild's shipped FFmpeg configuration and license inventory;
- FFmpeg, dav1d, zimg, and libzvbi notices from the linked FFmpegBuild release;
- LibDovi/libdovi licensing; and
- any other artifact shown in the final linked dependency graph.

Confirm that the tested FFmpeg binary was built without GPL or nonfree
components. Record the required notices, corresponding-source/relinking
obligations, modification disclosures, and the location where a distributed app
would provide them. Do not treat an upstream README badge as sufficient
evidence. The result is an engineering distribution review, not legal advice;
an unresolved obligation blocks adoption until reviewed competently.

## Acceptance

The slice passes when all of the following are true:

1. The app and focused tests build and pass for the supported tvOS toolchain.
2. The Debug launch route loads the committed manifest from the LAN server and
   the same `NamaPlayer` code is suitable for later product playback.
3. Representative H.264, HEVC, MKV, HDR10, Dolby Vision, audio selection,
   seeking, text subtitle, and image subtitle cases have repeatable recorded
   results on the physical setup.
4. Audio decodes and downmixes intelligibly through the television speakers;
   Atmos and passthrough remain clearly marked unverified.
5. Failures are visible and actionable, and diagnostics contain no URLs,
   headers, or credentials.
6. Redirect behavior is recorded; no custom locator header reaches a changed
   origin, and redirects stay within the allowed-origin set.
7. The dependency/distribution review finds no GPL/nonfree component and no
   unresolved obligation that prevents the intended distribution.
8. AetherEngine types remain confined to the Playback engine-integration files.

If playback, HDR/Dolby Vision output, credential containment, adapter isolation,
or distribution viability fails, stop before building product features around
AetherEngine and return the engine choice to design review.

That stop condition is active. AetherEngine `6.21.0` is **FAILED / REJECTED**
for adoption because credential containment and locator logging fail source
review. Physical playback, display, audio, redirect, and distribution rows are
still **UNRUN / UNVERIFIED**; distribution remains blocked. No replacement
engine has been selected.

## Evidence references

- [AetherEngine 6.21.0](https://github.com/superuser404notfound/AetherEngine/releases/tag/6.21.0)
- [AetherEngine license at 6.21.0](https://github.com/superuser404notfound/AetherEngine/blob/6.21.0/LICENSE)
- [AetherEngine package manifest at 6.21.0](https://github.com/superuser404notfound/AetherEngine/blob/6.21.0/Package.swift)
- [AetherEngine redirect-header policy at 6.21.0](https://github.com/superuser404notfound/AetherEngine/blob/6.21.0/Sources/AetherEngine/Demuxer/RedirectHeaderPolicy.swift)
- [AetherEngine redirect-header tests at 6.21.0](https://github.com/superuser404notfound/AetherEngine/blob/6.21.0/Tests/AetherEngineTests/RedirectHeaderPolicyTests.swift)
- [AetherEngine public Release logging at 6.21.0](https://github.com/superuser404notfound/AetherEngine/blob/6.21.0/Sources/AetherEngine/Diagnostics/EngineLog.swift)
- [FFmpegBuild 2.4.2 license inventory](https://github.com/superuser404notfound/FFmpegBuild/blob/2.4.2/LICENSES/README.md)
