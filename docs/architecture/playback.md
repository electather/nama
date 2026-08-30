# Playback

Status: the universal Apple application contains the production `NamaPlayer`
boundary backed by exact-pinned AetherEngine `6.21.0` and a `PlaybackView`
presentation for one complete provider-issued player request. The presentation
keeps loading, transport, clamped seek, elapsed time, explicit audio/subtitle
choice, completion, safe failure, and return-to-Details recovery visible through
touch, pointer, keyboard, and Apple TV focus. Automated macOS-host verification
loads, renders, controls, and stops controlled media and drives adversarial
origin, redirect, nested HLS, external-subtitle, replacement, expiry, and
surface-lifecycle cases through the real adapter. The provider-side
direct-progressive plan, open, report, and close lifecycle is implemented
through the first-party Jellyfin extension. Public lifecycle coordination and
the Details-to-playback coordinator remain target architecture.

The target Apple application reports a Nama-defined capability profile for the
current device, and the Jellyfin plugin translates it into provider playback
negotiation, preferring direct play, then stream-copy/remux, and transcoding
only when the media/device combination requires it or the user explicitly
asks.

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

The implemented direct-progressive slice mints purpose-separated,
self-contained leases from a protected key ring. It returns an opaque extension
URL plus one scoped request header, accepts exact `GET` and `HEAD`, and never
returns a stock path, provider identifier, or configured Jellyfin credential.
Plan identifiers are purpose-protected references of at most 256 characters to
five-minute in-memory plan records. The direct-only plan advertises only the
default audio track that open can materialize. Opened sessions expire after the
complete expected runtime plus 30 minutes, with a hard 24-hour maximum; longer
media is unsupported rather than receiving broader authorization. Provider-plugin
replacement retains the opaque session context. A Jellyfin restart retains
lease verification through the stable key ring while lost in-memory session
resources fail safely.

Issue #233 still owns HLS and external-resource coverage. That slice must keep
every playlist, segment, key, and subtitle child in the opaque namespace and
rewrite bounded control documents before those capabilities broaden. Stock
Jellyfin routes retain their existing behavior; Nama's guarantee covers only
access conferred through its opaque namespace.

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

For Jellyfin, the implemented direct-progressive telemetry path is the only
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
header replay. Issue #38 still owns representative physical iPhone or iPad,
Apple TV, and Mac playback evidence; capability negotiation and the full media
and interaction matrix remain with issues #39 and #40.

Provider-side implementation is tracked by umbrella issue #231: issue #232 owns
the extension runtime and direct-progressive tracer, issue #233 owns complete
HLS, fallback, and Track delivery, and issue #234 owns coherent progress.
