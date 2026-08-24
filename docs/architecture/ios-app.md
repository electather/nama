# Universal Apple application

Status: the universal SwiftUI target, manual-connection tracer, endpoint
transport eligibility, explicit permitted local-HTTP confirmation,
endpoint-bound persistent acknowledgement, selected-endpoint warning,
foreground LAN discovery, and verified endpoint restoration are implemented.
Device pairing, consumer media behavior, and product playback remain target
work. This note labels implemented, target, and deferred behavior explicitly;
a target invariant is required architecture, not a claim that its runtime
exists.

## Authority and fixed decisions

[ADR-0011](../adr/0011-universal-native-apple-application.md) establishes one
universal native Swift/SwiftUI application rooted in `apps/ios`.
[ADR-0029](../adr/0029-apple-platform-26-minimum.md) establishes iOS 26+,
tvOS 26+, and macOS 26+ as its minimums. iPadOS is an iOS application surface;
product and runtime acceptance names iPhone and iPad separately where their
windowing, input, privacy, or display behavior differs.

The application boundary is:

- Use one multiplatform application target, Swift 6 strict concurrency,
  Observation, and structured concurrency. Version 26 is a compatibility
  floor, not a checklist of SDK features.
- Keep a small composition root. Construct concrete dependencies there and
  pass only the required interfaces to each module; do not add a service
  locator, mutable registry, dependency dictionary, or app-wide view model.
- Share feature behavior and Nama-owned values across platforms. Add
  platform-specific presentation or system adapters only where input, focus,
  navigation, lifecycle, storage, or media APIs actually differ.
- Organize handwritten source by feature ownership rather than global
  `Views`, `Models`, `Services`, `Platform`, `Common`, or `Utilities` layers.
- Keep generated `nama.api.v1` values, Connect metadata, and Connect failures
  inside networking adapters. Features receive Nama-owned values and closed,
  safe failures.
- Module ownership directories and their scoped `AGENTS.md` guidance may exist
  before implementation. Add Swift source, interfaces, adapters, or packages
  only when current behavior requires them, and add no multi-engine factory
  before a second engine proves that interface.
- Under [ADR-0030](../adr/0030-one-active-apple-pairing.md), one app
  installation has one active endpoint-bound Device credential. Windows share
  that pairing while retaining independent presentation state.

## Implemented baseline

The checked-in application implements one connection tracer with manual entry,
optional LAN discovery, and verified endpoint restoration:

- `NamaApp` creates one `ConnectionFeature`, setup-status verifier, and
  Network-framework discovery adapter for each `WindowGroup` window.
- `NamaEndpoint` accepts an absolute HTTP or HTTPS URL with an explicit scheme
  and non-empty host, no credentials, query, or fragment, and an optional
  reverse-proxy path prefix. It normalizes the address and represents only
  HTTPS or the lexically permitted local-HTTP classes defined under
  [Connection target](#connection-target), without DNS resolution.
- `NWBrowser` browses `_nama._tcp` only after explicit activation and only
  while the window is foregrounded. It accepts a result only when TXT `url`
  normalizes as a transport-eligible `NamaEndpoint`; malformed and forbidden
  HTTP records are ignored without contacting the advertiser.
- Discovery candidates are keyed and sorted by normalized endpoint, merge
  duplicate records and interfaces, and retain sorted DNS-SD instance names
  only as untrusted secondary display text.
- Initial scanning lasts two seconds before an empty state. The browser remains
  active so later candidates appear immediately, and removal of the final
  candidate returns directly to empty.
- Selecting an HTTPS candidate invokes the same verifier as HTTPS manual
  submission. Selecting permitted local HTTP without an exact persisted
  acknowledgement first enters confirmation; Continue invokes that shared
  verifier, while Cancel returns to the candidate list. Selection replacement
  cancels the prior attempt, while later advertisement removal does not cancel
  verification of the selected endpoint.
- `NamaSetupStatusVerifier` calls generated `SetupService.GetStatus` once
  through a Nama-owned unary URLSession transport with a ten-second timeout and
  allowlisted client name, version, and platform metadata. The transport uses
  platform TLS trust, refuses every redirect before target contact, discards its
  location and response body, reports incompatible, and rejects streaming as
  unimplemented.
- The async `UserDefaultsVerifiedEndpointStore` actor retains the last
  successfully verified canonical endpoint and, for local HTTP, its exact
  endpoint-bound acknowledgement. The independently stored values authorize
  unencrypted contact only when both parse and match the same canonical local
  HTTP endpoint; missing, stale, malformed, or mismatched values ask again.
  Each window activates restoration once after SwiftUI installs its feature
  state, avoiding I/O from disposable view initializers while reusing the
  manual verification states. A legacy forbidden HTTP value is retained as
  display-only recovery data rather than constructed as a `NamaEndpoint`.
- Ready and setup-required results conditionally save against the preference
  generation captured when verification started. Successful local HTTP saves
  its acknowledgement, while saving HTTPS removes a stale acknowledgement.
  Safe failures and local cancellation retain the endpoint; Retry starts one
  new attempt. Change Endpoint cancels local work, advances the
  installation-wide generation, and clears both values so an older completion
  in another window cannot restore them.
- Local HTTP acknowledgement remains in the selected feature flow through safe
  failures and explicit Retry before successful persistence. The exact
  persisted acknowledgement is then shared across windows.
- The `@MainActor @Observable` feature owns editing, endpoint-bound local-HTTP
  acknowledgement lookup, local-HTTP confirmation, paused HTTP restoration,
  HTTPS-required, verifying, ready, setup-required, safe verification failure,
  and discovery presentation states. Forbidden
  manual HTTP remains editable, and a blocked restored value offers only Change
  Endpoint. The feature rejects stale verification and discovery completion by
  attempt identity.
- Leaving the foreground or closing the surface cancels active discovery and
  only active connection work while preserving terminal verification state.
  Local task cancellation is silent; a remote Connect `canceled` response is a
  visible cannot-connect failure.
- iPhone, iPad, and Mac use the shared native form presentation. Apple TV uses
  a focus-specific scrolling presentation over the same feature state. Every
  selected local HTTP state shows the unencrypted connection through text,
  symbol, and explicit accessibility semantics. Platform-specific permission
  guidance exists only where Apple exposes the Local Network privacy state.
- The app declares `_nama._tcp` and its Local Network purpose in its partial
  Info property list without a multicast entitlement. The macOS build uses App
  Sandbox with outgoing network-client access only.

The Swift Testing target covers endpoint normalization and address-class
boundaries, forbidden-HTTP discovery suppression, TXT parsing, canonical
candidate reconciliation, duplicate and removal behavior, discovery lifecycle
and timing, explicit selection, endpoint preference contents, blocked legacy
restoration, clearing, generation and stale-completion races, explicit one-time
restoration, successful and failed restoration, local-HTTP confirmation and
source-specific cancellation, exact endpoint-bound acknowledgement,
cross-window visibility, partial and mismatched preference recovery,
acknowledgement across failure and Retry, verification replacement and
cancellation, request construction and client metadata, redirect refusal,
unary-only transport enforcement, safe failure mapping, state transitions,
long endpoint presentation state, localized copy, warning semantics,
presentation actions, and television focus intent. `check:ios` lints Swift
formatting, runs the test target through its macOS host, and performs
signing-disabled iOS, tvOS, and macOS builds. These checks do not prove
physical-device privacy prompts, focus, accessibility, or playback behavior.

This baseline implements endpoint eligibility, endpoint-bound persistent
local-HTTP consent, persistent selected-endpoint warnings, and forbidden-HTTP
recovery. Proxy bypass and the local-networking ATS exception remain target
work.

The implemented source does not yet contain remaining transport hardening,
Keychain Device credentials, Pairing, Home, Library, Details, Watch State, or
Playback behavior.

## Target runtime topology

The target topology keeps shared state narrow and makes each window and feature
own its lifecycle:

```text
NamaApp composition root
├── application session
├── one playback coordinator
├── endpoint and paired-Device stores
├── concrete public-contract adapters
└── WindowGroup
    └── scene/window state
        ├── typed navigation and presentation
        └── feature owners
            └── narrow feature interfaces
                └── generated api.v1 networking adapters
```

### State lifetimes

| Lifetime | Owns | Never owns |
| --- | --- | --- |
| App installation | Current verified Nama endpoint, paired-Device availability, authentication phase, session identity, and the single playback coordinator | Navigation, media collections, view errors, sheets, or control state |
| Scene or window | Typed navigation, sidebar or tab selection, sheets, selected opaque IDs, and feature-owner instances | Device credentials or another window's transient work |
| Feature | Its explicit state machine, loaded values, current operation identity, and structured tasks | Another feature owner or global presentation |
| View | Focus, field editing, disclosure, and animation triggers | Passed-in model ownership, networking, persistence, or business policy |

The application session is a narrow state module, not a view model for the
entire product. It exposes credential availability and session identity; secret
credential material remains inside the paired-Device store and authenticated
networking adapter.

### Feature ownership

The source tree reserves these ownership directories for agent guidance. A
directory containing only `AGENTS.md` identifies target ownership; it does not
claim that the module compiles or runs:

| Module | Ownership |
| --- | --- |
| Application Session | Verified endpoint, paired-Device availability, authentication phase, and session identity |
| Connection | Explicit LAN discovery, manual endpoint entry, verification, and last-verified endpoint persistence |
| Pairing | Device-code lifecycle, approval polling, endpoint-bound credential commit, and revocation response |
| Home | Product entry composition, including Continue Watching when Watch state exists |
| Library | Provider-neutral browse, search, and bounded list loading |
| Details | Movie, show, season, and episode presentation plus watched and playback intents |
| Playback | Plan, open, control, report, close, and the sole playback-engine adapter |
| Watch State | Confirmed watched and resume behavior shared by Home, Details, and Playback |

Features expose typed values and user intents. The scene root handles
navigation and presentation intents; installation-scoped modules handle only
genuinely shared behavior. Details does not own Playback, Pairing does not
mutate Home, and no application event bus or notification-driven control flow
connects feature owners.

Networking, persistence, presentation, fixtures, and platform-specific files
stay with their owning feature while only that feature uses them. A
narrowly-named shared module appears only after two real callers require the
same semantics. A source seam does not require a Swift package: extract a local
package only after its interface is stable, its implementation is substantial
and independent of application scenes and resources, and measured build,
reuse, or test-isolation value justifies the package. The committed generated
`NamaAPI` package remains the intentional transport-edge package.

### Composition and dependency direction

`NamaApp` constructs the endpoint store, paired-Device store, public-contract
adapters, application session, and playback coordinator. Observable
installation state and the playback coordinator may use typed SwiftUI
environment injection where hierarchy-wide access is legitimate. Feature
clients are passed explicitly to feature-owner initializers; there is no
environment-backed dependency bag.

The dependency direction is:

```text
views -> feature owners -> narrow interfaces -> concrete adapters
                                             -> generated api.v1
```

The interface is the caller and test surface. Feature interfaces describe
behavior, cancellation, safe failures, and ordering constraints rather than
mirroring generated RPC methods. The core is the only media data source in the
MVP, so the application adds no generic repository layer.

## Session, windows, and navigation

### One active pairing

One app installation has one active paired Nama endpoint and Device credential.
Candidate endpoints may be verified in any window without receiving the active
credential. Switching is an explicit replacement transaction:

1. verify the candidate endpoint without attaching the existing credential;
2. complete a fresh Device pairing at that endpoint;
3. durably store the new endpoint-bound Keychain record; and
4. only then retire the old paired record and publish the new session identity.

Cancellation, denial, expiry, verification failure, or network loss before the
new durable commit leaves the existing pairing intact. Endpoint similarity,
service name, certificate identity, or a similar response never permits
credential replay.

The app treats Pairing and Device credentials as opaque contract values. A
Device credential has no scheduled MVP expiry, so its
`BearerCredential.expires_at` is absent; the app never invents a refresh
deadline. Pairing expiry affects only approval polling and temporary credential
delivery. `CREDENTIAL_INVALID` is the single definitive bearer failure that
clears or quarantines the paired record and returns to visible Pairing.

### Persistence and restoration

Connection and Pairing own two intentionally different records:

- The implemented `UserDefaults` record stores the last verified canonical
  Nama endpoint and, when applicable, its exact local-HTTP acknowledgement for
  unpaired reconnection convenience.
- The target Keychain record contains both the Device credential and its exact
  canonical Nama endpoint. It uses
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, does not synchronize through
  iCloud Keychain, and is not reconstructed from independent defaults values.

Successful ready and setup-required status responses write the canonical
endpoint and its exact local-HTTP acknowledgement when no later explicit clear
has invalidated their preference generation. Saving HTTPS removes stale HTTP
acknowledgement. On launch, each Connection window reads the preference once
and reverifies it through the same bounded request as manual entry. Safe
failure and cancellation retain the preference. Retry creates one new attempt;
Change Endpoint cancels local work, invalidates every older window attempt,
removes both preference values, and returns to endpoint selection.

A successful pairing writes the Keychain record before updating the convenience
endpoint. On launch, a paired session comes entirely from the Keychain record.
Unknown, partial, damaged, or unauthenticatable record versions fail closed
into visible re-pairing and are quarantined rather than silently rewritten.
Only explicit, tested migrations may transform a known record version.

Launch uses an explicit restoration gate:

1. read and validate the endpoint-bound paired-Device record;
2. reverify that exact Nama endpoint without redirecting the credential;
3. establish authenticated availability through the public Device contract
   when its runtime exists; and
4. enter consumer content only after the session is usable.

With no device-local media cache, an offline paired launch shows a
paired-but-unavailable retry state rather than stale Home content. A definitive
invalid or revoked Device credential returns to Pairing while preserving the
last verified endpoint. Offline, timeout, TLS, server-unavailable, or transient
authentication failures preserve the paired record. The app never flashes
Connection or Home while restoration remains unresolved.

### Windows and navigation

`WindowGroup` supports multiple windows where iPadOS and macOS offer them.
Every window shares the installation pairing but owns its navigation,
selection, presentation, searches, and in-flight feature work. iPhone and Apple
TV naturally remain effectively single-window.

Navigation uses typed, scene-local destinations and selections. A platform root
may present the same semantics through a stack, split view, tab structure, or
Apple TV focus hierarchy. The architecture does not prescribe exact tabs,
sidebar sections, or toolbar layout before the owning product feature exists,
and it adds no global router.

Restoration may retain only safe durable context such as a selected section or
opaque canonical item ID. The app restores it only after the paired session is
re-established. Forms, failures, generated messages, locators, playback plans,
and playback sessions are never restored. External deep links remain deferred
until an accepted ingress use case exists.

One running app process owns at most one active playback session. Starting
playback from another window replaces and safely closes the previous session,
giving system Now Playing and remote commands one owner. Closing an unrelated
window does nothing; closing the playback-owning surface closes playback.

## State, concurrency, and lifecycle

Application, scene, feature, navigation, and playback presentation state use
`@MainActor @Observable` ownership. Network and persistence interfaces are
asynchronous and `Sendable`. An adapter becomes an actor only when its mutable
implementation requires serialization; the architecture does not assign one
actor per module.

Feature operations use explicit enum state rather than independent loading,
success, and failure booleans. One operation owns one structured task and
attempt identity. Replacement cancels the previous task, and stale completion
cannot mutate current state. Local structural cancellation is silent. Remote
`canceled`, transport, authentication, incompatibility, and Nama-availability
failures remain distinct safe outcomes where their recovery differs.

Detached tasks are not a default escape from actor isolation. CPU-intensive
work may leave the main actor only after measurement establishes the need and
its inputs and result are safe `Sendable` values. Views perform no I/O,
decoding, sorting, filtering, or other expensive work in `body`.

Each active feature owns its load and refresh policy. Identity-keyed tasks
cancel when the endpoint, session, selection, or query changes. Returning to
the foreground lets only visible stale features refresh; it does not trigger a
global refresh storm or hidden prefetch. A session-identity change invalidates
all values derived from the previous paired session.

The Apple application schedules no catalog synchronization, reconciliation, or
general retries in the background; the core owns those responsibilities.
Pairing polling, discovery, browsing, and refresh run only while their feature
is active. Bounded background execution may be added only for a demonstrated
final playback checkpoint or credential transition, not as a general
`BGTaskScheduler` framework.

Logical mutations create an `operation_id` once per user intent and retain it
with an identical payload across transport retries. A genuinely new user action
receives a new ID. Playback telemetry follows the contract's `event_id` and
sequence rules. Reads, pairing status, and other documented safe operations may
retry only within owned deadlines and `RetryInfo`; unsafe operations never gain
automatic retries merely because a generic client supports them.

## Connection target

Connection treats a Nama endpoint as a transport address, not deployment
identity. Changing endpoints always requires fresh verification and, once
paired, fresh Pairing.

LAN discovery uses Network framework `NWBrowser` for `_nama._tcp`. Browsing
starts only after explicit user action and stops outside the foreground. A
browse result is usable only when its TXT record contains one structurally
valid, transport-eligible `url` value. Public or otherwise forbidden HTTP
advertisements are ignored like malformed records. The service instance name
is untrusted secondary display text, unknown TXT keys are ignored, and results
sharing one normalized URL form one candidate.

Discovery never contacts a candidate or automatically selects a sole result.
Selecting a discovery result and submitting a manual URL enter the same
verification path. Manual entry remains available on every platform.

`NamaEndpoint` classifies the canonical host lexically without DNS resolution.
HTTPS is always transport-eligible. Plain HTTP is eligible only for:

- IPv4 loopback `127.0.0.0/8`, private `10.0.0.0/8`, `172.16.0.0/12`, and
  `192.168.0.0/16`, or link-local `169.254.0.0/16` addresses;
- IPv6 loopback `::1`, unique-local `fc00::/7`, or link-local `fe80::/10`
  addresses; and
- `localhost`, proper names ending in `.localhost`, or proper names ending in
  `.local`.

IPv4-mapped IPv6 literals inherit the embedded IPv4 classification. A zone
identifier is valid only on an IPv6 link-local literal. Matching is
case-insensitive and suffix-boundary-aware; trailing-root-dot variants are not
accepted. Every other plain-HTTP destination is forbidden, including public,
unspecified, multicast, reserved, documentation, benchmark, and shared
carrier-grade NAT addresses, unrelated unqualified names, and DNS aliases that
happen to resolve locally.

`NamaEndpoint` represents only HTTPS or permitted local-HTTP endpoints and
distinguishes malformed input from an address that requires HTTPS. Manual
forbidden HTTP remains editable with “This Nama endpoint requires HTTPS.” and
never starts a request. Discovery suppresses it. A previously verified
forbidden HTTP endpoint remains visible after upgrade in an “HTTPS required”
state with only Change Endpoint; the app neither contacts nor silently deletes
it and never rewrites its scheme.

Before the first request to a permitted local-HTTP endpoint, the app asks
“Connect without HTTPS?” and explains, “Traffic to this Nama endpoint won’t be
encrypted. Continue only if you trust this endpoint and network.” Cancel
returns manual entry to its populated editor, discovery to its candidate list,
or restoration to a paused Continue-or-Change-Endpoint state without starting
a request. Continue retains acknowledgement through local failures and retries.
After successful verification, the app persists acknowledgement for that exact
canonical endpoint and shares it across windows. Any scheme, host, port, or
path-prefix change requires fresh acknowledgement. Legacy permitted HTTP
restoration without acknowledgement asks before contact. Every selected
local-HTTP state presents the non-color-only warning “HTTP connection —
traffic is not encrypted.”

Every control-plane adapter derives its transport from a `NamaEndpoint` and
inherits this policy; provider-issued artwork and media locators retain their
separate origin and redirect contract. Local HTTP bypasses configured proxies,
while HTTPS retains normal system proxy behavior. Nama endpoint traffic refuses
every redirect before contacting its target and reports the response as
incompatible without exposing or logging the redirect location.

Verification makes one cancellable, ten-second `SetupService.GetStatus` call
with platform TLS trust and no certificate bypass. `initialized=true` means the
endpoint is ready for Pairing; `initialized=false` is a verified endpoint that
requires Administrator setup. Nama availability, transport/TLS/timeout, and
incompatible responses remain distinct safe states without raw URLSession,
TLS, or response detail.

Discovery declares `_nama._tcp` in `NSBonjourServices` and explains local
network access through `NSLocalNetworkUsageDescription` in the application’s
partial Info property list. `NSAllowsLocalNetworking` enables eligible local
HTTP on every supported platform; the app never declares
`NSAllowsArbitraryLoads` or static per-domain exceptions. Browsing this one
declared service does not add the multicast entitlement. iPhone, iPad, and Mac
expose local-network permission behavior; Apple TV does not expose the same
prompt.

The app does not use a global `NWPathMonitor` to gate requests. A path
observation cannot prove that one Nama endpoint is reachable, trusted,
compatible, or healthy; bounded endpoint operations remain authoritative.

### Connection runtime acceptance

When Connection target behavior lands, runtime acceptance requires:

- LAN discovery on a physical iPhone, physical iPad, Apple TV, and Mac;
- manual HTTPS and permitted local-HTTP entry for LAN, VPN, and reverse-proxy
  deployments on all four surfaces;
- HTTP confirmation, persistent warning, cancellation, legacy restoration, long
  endpoint, and accessibility behavior on all four actual surfaces;
- focused coverage of every allowed and forbidden address class, local-name
  boundary, discovery suppression, proxy selection, and redirect refusal;
- public HTTP rejection before transport creation on every ingress path;
- local-network and ATS allow, deny, and later-settings-change behavior on
  physical iPhone, physical iPad, Apple TV, and Mac;
- foreground cancellation, candidate deduplication, manual fallback, and
  pairing replacement behavior on their actual surfaces; and
- every unrun physical-device row remaining explicitly unverified.

Simulator behavior is not local-network privacy proof.

## Networking, compatibility, and failures

The composition root creates concrete adapters over generated Connect clients.
Connection verification, Pairing, Library, Playback, and Watch State expose
narrow interfaces that accept and return Nama-owned values. There is no broad
public `NamaClient`, generated-message environment value, or handwritten
parallel client.

Every released RPC sends the allowlisted `nama-client-name`,
`nama-client-platform`, and `nama-client-version` metadata defined by the API
contract. The stable application name remains `nama-ios` for compatibility;
platform distinguishes `ios`, `tvos`, and `macos`. These values are untrusted
diagnostics, not attestation.

Protobuf additive compatibility and public Connect failures govern evolution.
The application does not parse server versions, reflect over generated
messages, or maintain legacy clients. `CLIENT_VERSION_UNSUPPORTED`, an
unimplemented method, or an invalid incompatible response becomes a safe
incompatible state rather than an inferred fallback.

Networking adapters map Connect codes, stable Nama reasons, standard Google RPC
details, and safe field details into closed feature failures. Unexpected
defects expose only an allowlisted correlation ID where useful. Feature owners,
not a global error presenter, decide recovery presentation.

Structured logging uses allowlisted fields and categories owned by each feature
or adapter. Logs never contain request or response bodies, arbitrary headers,
credentials, polling tokens, raw generated messages, unrestricted endpoint
input, locator URLs, locator headers, or provider failures. No analytics or
telemetry backend is added without a current accepted use case.

## Media data and presentation

The MVP application is online-first. Before a concrete offline-read requirement
exists, it persists no media catalog, search results, details, Watch state,
artwork, or mutation queue and adds no SwiftData model. The core remains
canonical for media and Watch state. Offline downloads and offline mutations
remain outside scope.

Feature-specific state and presentation projections stay with their feature. A
Nama-owned value moves to a narrowly named shared module only when two real
features need the same semantics. Opaque identifiers are compared and returned;
the application never parses, sorts, or synthesizes them. Provider identifiers,
SDK types, and generated transport values never become product model values.

Home, browse, search, and child lists consume lean summaries. Details and
technical source values load only when their surface requires them. Large lists
use bounded server-driven pages or continuation tokens once the public contract
supplies them. Each feature owns page state per session and query, preserves
server order, deduplicates only by opaque Nama identity, cancels obsolete page
requests, and retries a failed page without discarding confirmed pages.

Artwork views receive no locator URL. A Nama-owned artwork loader accepts an
artwork reference, resolves and fetches within the locator security policy, and
returns decoded presentation data. Its initial cache is bounded and
memory-only, keyed by the artwork reference rather than a locator. Persistent
`URLCache` or disk image caching requires a later design for retention,
secret-bearing cache keys, invalidation, and offline behavior.

Watch State publishes stable confirmed changes across Home, Details, Playback,
and windows. A watched/unwatched mutation may expose an explicit pending state,
but it does not replace the stable value until Nama confirms the operation. On
failure, the previous confirmed value remains with a safe retry path. Playback
clock ticks never enter this shared state.

Observable state remains granular. Views read only values they render, and
subviews split at invalidation seams. Lists use stable opaque identity rather
than indices or mutable display values. Playback clock state remains separate
from stable playback state, track lists, and focused controls.

## Platform adaptation and native presentation

Shared feature behavior, intents, state machines, and Nama-owned values do not
branch by platform. Presentation first adapts through window size, SwiftUI
environment, focus, commands, and container choice. Conditional compilation is
reserved for APIs or scenes that genuinely do not exist on another supported
platform. A separate presentation is appropriate when interaction semantics
materially differ, as with Apple TV focus or Mac commands.

On iPhone, iPad, and Apple TV, entering the background records a bounded final
checkpoint and closes active playback in the MVP. Picture in Picture,
background audio, and AirPlay-specific behavior remain deferred. On Mac,
losing focus does not stop playback; closing the playback surface or replacing
its load does.

SwiftUI's standard controls, semantic colors, typography, materials,
containers, and platform-native Liquid Glass are the default UI system.
Explicit glass effects are presentation details, not architecture, and are
added only when a product interaction requires them. The app adds no custom
design-system package or broad appearance wrapper; a named style or custom
control must represent repeated product behavior rather than visual similarity
alone.

The first release may provide only English translations, but every user-facing
string remains localization-ready through the existing String Catalog.
Ambiguous strings receive translator comments, and dates, durations, numbers,
and lists use locale-aware formatting. The app adds no custom localization
layer and never claims translations it does not ship.

Accessibility is part of each feature's interface and acceptance. Each feature
defines labelled actions, reading and focus order, Dynamic Type behavior where
supported, keyboard/pointer/remote operation, high-contrast behavior,
reduced-motion handling, long-content behavior, and visible alternatives to
gestures. Apple TV focus restoration and Mac keyboard commands are platform
behavior, not optional polish. Self-contained previews cover meaningful
loading, empty, content, long-content, pending, and failure states without live
services or credentials.

## Playback boundary

[ADR-0012](../adr/0012-single-playback-engine-adapter.md) confines the selected
engine to one concrete Nama-owned adapter. The adapter is the only module
allowed to import the engine. Engine views, publishers, tracks, cues, errors,
and configuration types never cross into another feature or the public RPC
layer.

The adapter exposes Nama-owned values:

- a request with a short-lived media locator, origin-scoped headers, allowed
  redirect origins, MIME information, resume position, and external subtitle
  locators;
- stable playback state, separate high-frequency clock state, opaque audio and
  subtitle tracks, detected video characteristics, and sanitized failures; and
- load, stop, play, pause, seek, audio-selection, and subtitle-selection
  operations.

One load owns one task. A newer load cancels and stops the previous playback
session. Leaving the owning surface stops its session. Replacement cancellation
is not a user-visible failure. Native and software rendering surfaces may
switch inside the adapter, but the adapter remains the sole engine lifecycle
owner.

The architecture does not select an engine before one exact revision passes the
source, locator-security, logging, licensing, media, distribution, and
physical-device gates below. It adds neither a lowest-common-denominator player
interface nor a multi-engine factory. AetherEngine `6.21.0` remains ineligible
under the recorded source-review findings.

### Locator and logging invariants

[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md) establishes the
direct-delivery security boundary. Media travels directly from the provider to
the client. The core is not a media relay, and an on-device loopback bridge used
by a player does not change that boundary.

- Locators and locator headers are session-memory-only. Never persist or place
  them in logs, errors, analytics, diagnostics, metadata, defaults, or
  Keychain.
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

### Player interaction invariants

- Critical controls are visible, focusable, and labelled; no required action
  exists only as an undiscoverable remote gesture.
- Back or Menu stops playback before leaving the player. Loading and failure
  states remain actionable.
- Audio and subtitle selection use an explicit focus-stable Apple TV surface.
  SwiftUI `Menu` produced context-menu and focus failures even though the
  evaluated engine discovered both audio tracks.
- Clamp displayed position and seek targets to the known duration. Engines may
  report a final clock beyond duration.
- Treat source dynamic range and actual output dynamic range as separate facts.
  Detected HDR or Dolby Vision metadata does not prove display-mode switching.
- Keep fixture IDs and diagnostics out of the product playback model. Product
  diagnostics remain allowlisted and never display locators or headers.

### Engine acceptance

Before product playback depends on an engine:

1. Pin and inspect the exact source revision, including redirect, HLS
   subrequest, logging, error, and locator-refresh behavior on iOS, tvOS, and
   macOS.
2. Keep engine imports confined to the adapter and test Nama-owned mapping,
   lifecycle, track selection, platform interaction, and redaction behavior.
3. Exercise SDR, HDR10, Dolby Vision, multichannel audio, text and image
   subtitles, seeking, track switching, redirects, expiry, and recovery on
   representative physical iPhone or iPad, Apple TV, and Mac hardware. Display
   switching and home-theater audio claims require the actual Apple TV,
   display, and audio route.
4. Verify Release logs and network captures contain no locator, query secret,
   header, or cross-origin credential replay on every supported platform.
5. Inspect signed artifacts, linkage, bundled media libraries, notices,
   corresponding source, and relinking obligations before distribution.

Simulator builds and source comments are evidence, not physical-device proof.
Generated Swift bindings and generic platform builds prove ownership and
compilation, not product playback.

## Verification architecture

Each module interface is both its caller and automated test surface:

- feature tests cover state transitions, cancellation, stale completions,
  session invalidation, mutation-ID reuse, paging, and confirmed-state
  publication;
- networking-adapter tests cover generated request paths, client metadata,
  deadlines, safe retry rules, failure normalization, correlation, and absence
  of generated-type leakage;
- persistence-adapter tests cover endpoint normalization, endpoint-credential
  binding, replacement commit ordering, known-version migration, and damaged
  records;
- artwork and playback tests cover origin/header policy, cancellation, mapping,
  lifecycle, and redaction without treating generated round trips as product
  behavior; and
- deterministic previews cover visual states without live network, Keychain,
  or provider dependencies.

UI automation is added only when a critical interaction cannot be defended
reliably through a module interface and actual-surface verification. Platform
builds remain compile evidence. Real Pairing, focus, navigation, local-network
privacy, accessibility, playback, and lifecycle flows run on each affected
surface. No unrun hardware, provider, security, or accessibility row is
reported as passing.

## Deferred behavior

The architecture deliberately does not reserve implementation for:

- multiple named Nama endpoint profiles in one Apple app installation;
- device-local media persistence, offline reads, offline mutations, or
  downloads;
- external deep links before a real ingress use case;
- Picture in Picture, background audio, AirPlay-specific behavior, or a general
  application background scheduler;
- separate Apple-platform codebases or packages for empty future features;
- a custom design system, dependency framework, global router, event bus, or
  app-wide view model; or
- a second playback engine or speculative playback factory.

These may enter design only through an accepted current use case. Scalability
means each change stays local behind an earned interface; it does not mean
prebuilding every plausible extension.
