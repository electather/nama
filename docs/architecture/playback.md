# Playback

Status: the universal Apple application contains the production `NamaPlayer`
boundary backed by exact-pinned AetherEngine `6.21.0` and a `PlaybackView`
presentation for one complete provider-issued player request. The presentation
keeps loading, transport, clamped seek, elapsed time, explicit audio/subtitle
choice, completion, safe failure, and return-to-Details recovery visible through
touch, pointer, keyboard, and Apple TV focus. Automated macOS-host verification
loads, renders, controls, and stops controlled media and drives adversarial
origin, redirect, nested HLS, external-subtitle, replacement, expiry, and
surface-lifecycle cases through the real adapter. The provider-side progressive
and HLS plan, open, report, and close lifecycle, fallback negotiation, and
audio/subtitle Track delivery are implemented through the first-party Jellyfin
extension. Public lifecycle coordination and the Details-to-playback
coordinator remain target architecture.

The target Apple application reports a Nama-defined playback capability profile
for the current player, and the Jellyfin plugin translates that profile into
provider playback negotiation. The profile is a conservative pre-plan input-
consumption promise rather than an inventory of every AetherEngine decoder, an
output-fidelity claim, or a guarantee that every matching Source will load or
perform acceptably. Playback prefers direct delivery, then provider remux,
provider audio conversion with copied video, and provider video conversion only
when the media/player combination requires it or the person explicitly selects
a bit-rate cap.

### Capability profile and preferences

`NamaPlayer` owns one synchronous, local, total capability-profile builder
behind its concrete adapter seam. Each planning attempt receives a fresh
profile. Building it opens no Source, contacts no provider, performs no network
I/O, and persists nothing. A reliable runtime fact may remove a capability; an
unavailable or indeterminate optional fact removes that optional claim rather
than failing planning or broadening support. Output tone mapping or downmixing
does not make an input unsupported.

The initial Apple profile is deliberately narrower than AetherEngine `6.21.0`:

- HTTP progressive and HLS delivery;
- at most 3,840 by 2,160 pixels, 10-bit video, and eight audio channels;
- SDR, HDR10, and Dolby Vision inputs;
- MP4 with H.264 or HEVC video and AAC, AC-3, or E-AC-3 audio;
- MKV with H.264 or HEVC video and AAC, AC-3, E-AC-3, or FLAC audio;
- SRT, ASS, and WebVTT subtitles as embedded or external Tracks; and
- embedded PGS image subtitles, with provider burn-in available when a declared
  subtitle format cannot otherwise accompany the selected delivery.

Capability strings use the exact lowercase Nama tokens `mp4`, `mkv`, `h264`,
`hevc`, `aac`, `ac3`, `eac3`, `flac`, `srt`, `ass`, `vtt`, and `pgs`.
Additional engine formats do not become Nama capabilities until a focused
planning fixture and physical Apple playback evidence support them.

The Apple app sends `AUTO` with no implicit bit-rate cap for ordinary Play.
Playback Options is scene-local and per-play; it offers Auto or explicit 4, 8,
20, and 40 Mbps caps without resolution labels. A new Details destination
starts at Auto and leaving it discards the choice. The Apple app does not expose
`ORIGINAL` until that value has behavior distinct from uncapped compatibility
fallback. It sends empty preferred-language lists and `AUTO` subtitle
preference, leaving initial selection to provider/container defaults including
eligible forced subtitles.

### Negotiation and fallback

A Playback strategy describes provider-side delivery transformation, not
AetherEngine's local demuxing, decoding, audio bridging, tone mapping, or
downmixing:

- `DIRECT` leaves provider media unchanged;
- `REMUX` changes only provider carriage/container while audio and video copy;
- `TRANSCODE_AUDIO` copies video while converting selected audio; and
- `TRANSCODE_VIDEO` converts video and may also convert audio or burn subtitles.

Per-Track actions retain the finer `COPY`, `TRANSCODE`, `BURN`, `EXTERNAL`, and
`OMIT` evidence. The core validates the plugin plan against the exact selected
Source, submitted profile and preferences, strategy, expected output, Track
actions and defaults, expiry, and newly mapped public Track identities. It
never repairs, reclassifies, changes Source, or tries another provider after an
inconsistent response; invalid plugin evidence fails
`INTERNAL/PLUGIN_RESPONSE_INVALID`.

Provider negotiation chooses one least-destructive compatible result. An
AetherEngine load failure is visible and does not trigger an automatic,
increasingly destructive replan. `PlanPlayback` follows the documented safe
retry rules; one still-active Play attempt may replan once after plan expiry.
Every `OpenPlayback` attempt retains one operation ID and identical request
across retries. Primary Play opens the plan defaults. Session Tracks that cannot
switch without reopening remain visible but disabled until the ordered
replacement lifecycle implements that behavior.

Issue #233 implements truthful Jellyfin planning, fallback, Track evidence, and
the complete opaque media graph on the extension runtime and direct-progressive
foundation from issue #232. Umbrella issue #231 owns the accepted extension
boundary.

[ADR-0012](../adr/0012-single-playback-engine-adapter.md) confines the selected
engine behind one Nama-owned adapter with app-owned request, state, clock,
track, and error types; engine types do not cross that boundary, and no
multi-engine factory exists before a second implementation proves one.

[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md) keeps provider
media and short-lived authorization direct between provider and client.
[ADR-0032](../adr/0032-aetherengine-mvp-security-exception.md) selects
AetherEngine `6.21.0` for the private single-user MVP and accepts two bounded
limitations: the engine may place complete short-lived locator URLs in local
Release logs and may replay locator headers between core-validated allowed
redirect origins. Destinations outside that allowlist, reusable credentials,
Nama-owned locator logging or persistence, and locator-bearing user errors
remain prohibited.

The concrete adapter contains both engine limitations behind a session-scoped
loopback bridge. The engine receives opaque loopback locators without upstream
Locator headers; the bridge alone retains upstream Locator material, validates
the initial and redirected origin, rewrites HLS child references, and reapplies
headers only within the request's core-validated allowlist. The bridge is part
of the concrete adapter, not a second playback engine or public media relay.

[ADR-0036](../adr/0036-first-party-jellyfin-server-extension.md) requires a
manually installed first-party Jellyfin server extension for Jellyfin playback
and coherent progress. The extension validates its own host and exposes one
versioned private JSON/HTTP protocol to the supervised Jellyfin provider plugin;
Nama does not inspect Jellyfin versions directly. Missing, unhealthy, or
incompatible extensions advertise none of the extension-backed capabilities.
Private control endpoints accept only a real Jellyfin API key, and the optional
handshake probe has its own short deadline so a stalled extension cannot erase
an already-verified stock connection.

The implemented Jellyfin profile mints purpose-separated, self-contained leases
from a protected key ring. One session lease header is bound to separately
protected opaque main-media and external-subtitle resource paths. Exact `GET`
and `HEAD` requests dispatch internally to the already negotiated stock target;
no stock path, provider identifier, or configured Jellyfin credential enters a
locator.

The extension clones each observed source before invoking exact-tag Jellyfin
`StreamBuilder`, because that negotiation path mutates its input DTO. It
translates direct-play combinations, progressive/HLS protocols, subtitle
delivery modes, size, bit-depth, channel, dynamic-range limits, quality cap,
language order, and subtitle preference into one provider decision. Strategy,
expected output, selected Tracks, and `COPY`, `TRANSCODE`, `BURN`, `EXTERNAL`,
or `OMIT` actions come from that result. Only audio and subtitle Tracks whose
explicit Open selection preserves the planned protocol, strategy, container,
and codecs are advertised. Unsupported output, an unavailable exact Source, or
an unadvertised Track choice fails instead of guessing or switching Source.
Session Tracks remain `switchable_without_reopen=false`; changing a Track
during an active session therefore requires close, replan, and reopen.

Progressive bytes pass through untouched. HLS master, variant, media, key, and
subtitle control documents are buffered only within their fixed bound, stripped
of stock credential query values, and rewritten so every child is another
session-bound opaque resource. Same-origin stock redirects are reminted as
session-bound opaque resources; unsafe redirect targets fail closed, and
redirect bodies are suppressed. Segments and other non-redirect media bodies
continue streaming through Jellyfin. Plans expire after five minutes. Opened
sessions and every main or child resource expire after the complete expected
runtime
plus 30 minutes, with a hard 24-hour maximum; longer media is unsupported.
Provider-plugin replacement retains the opaque session context. A Jellyfin
restart retains self-contained resource verification through the stable key
ring, while lost provider resources fail safely. Stock Jellyfin routes retain
their existing behavior; Nama's guarantee covers only access conferred through
its opaque namespace.

[ADR-0014](../adr/0014-four-stage-playback-lifecycle.md) defines the
plan, open, report, and close lifecycle for the target public and plugin
contracts.

The target local reporting path makes the core authoritative before provider
telemetry. The Apple client sends ordered, idempotent Playback checkpoints at
the session's 15-second interval while playing and immediately for meaningful
state, settled-seek, and Track-selection changes. Pause reports without closing;
stop, completion, failure, cancellation, surface closure, and eligible
foreground loss close with one frozen final snapshot.

Canonical Watch state preserves a legitimate newer lower position. Completion
marks watched and clears resumable position; other Playback activity preserves
watched status. Event acceptance, optional Watch-state change, session ordering,
and the original result commit atomically, while provider work remains outside
that transaction. The public contract owns exact replay, retention, transaction,
and terminal-race behavior; the Apple note owns coalescing, bounded retry,
replacement ordering, lifecycle, and safe failure presentation.

For Jellyfin, the implemented playback telemetry path is the only
provider writer for state produced by that Nama playback session. It invokes
Jellyfin start, ordered progress, and stop exactly once per accepted event;
provider response loss remains ambiguous and the plugin never blindly replays
it. Coherent progress export in issue #234 handles other Activity origins and
must never write the same canonical version. Its target extension operation
saves watched state and position together, validates optional duration against
the current Jellyfin item runtime, and reads the provider result back.

The integration pins AetherEngine's exact source revision and complete resolved
dependency closure and confines its rendering and control types to
`NamaPlayer`. The [distribution record](aetherengine-distribution.md) owns the
reviewed build, linkage, checksum, notice, source, signing, and relinking
evidence. Issue #161 proves a controlled SDR HLS fixture through the real
adapter. Issue #162 adds a per-load loopback broker that exposes only opaque
local routes to the engine, validates every remote destination against the
request's exact normalized origin set, and rewrites allowed redirects and HLS
references back through that broker. Automated macOS-host tests cover its
security and lifecycle behavior while recording the accepted allowed-origin
header replay. Issue #38 retains its representative physical adapter evidence;
issue #40 delivered the player presentation baseline. Issue #39 owns the
end-to-end capability and fallback matrix through pinned Jellyfin and
representative physical iPhone or iPad, Apple TV, and Mac:

- MP4/H.264/AAC SDR, MKV/HEVC/E-AC-3 HDR10, Dolby Vision, declared text
  subtitles, and PGS image subtitles exercise direct delivery;
- an incompatible container exercises remux with copied audio and video;
- TrueHD or DTS-family audio outside the initial profile exercises audio
  conversion with copied video;
- VP9 or AV1 outside the initial profile exercises video conversion;
- a selected DVD/DVB subtitle outside the initial profile exercises burn-in;
- a direct-compatible high-bit-rate Source exercises an explicit cap; and
- the absence of any safe compatible result exercises
  `FAILED_PRECONDITION/PLAYBACK_UNSUPPORTED`.

Every successful row records the public strategy, expected output, Track
actions, exact Source, actual device/display result where applicable, and proof
that media travels from Jellyfin to the Apple client rather than through the
core. Unrun or incapable hardware/display rows remain explicit instead of
passing by inference.

Provider-side implementation is tracked by umbrella issue #231: issue #232
delivered the extension runtime and direct-progressive tracer, issue #233
delivered complete HLS, fallback negotiation, and Track delivery, and issue
#234 owns coherent progress.
