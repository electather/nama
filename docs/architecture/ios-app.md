# Universal Apple application

Status: the universal SwiftUI target, endpoint connection and restoration,
acknowledged eligible local HTTP, foreground LAN discovery, native Better Auth
device authorization, refresh rotation, endpoint-bound Keychain token storage,
provider-neutral Home source, and safe Home artwork loading are implemented.
The connection and authorization baseline's Apple-platform builds and
macOS-host tests pass. A
signed Apple TV 4K simulator has completed local-HTTP acknowledgement,
no-browser authorization through the generated CLI, scoped consumer
verification, Keychain commit, and relaunch restoration. The production
`NamaPlayer` boundary is implemented; controlled rendering and adversarial
locator, replacement, expiry, and shared lifecycle behavior pass through its
macOS-hosted real-engine tests. Home loading, empty, long-title, and failure
fixtures have been inspected on iPhone 17 Pro, iPad Pro 13-inch, and Apple TV 4K
simulators and an Apple Development-signed sandboxed Mac build. Home poster
loading and fallback actual surfaces on iPhone, iPad, Apple TV, and Mac remain
unverified because the persisted endpoint was unavailable. Product consumer
media coordination, physical Apple hardware, expiry-driven actual-surface
refresh, and the remaining Apple surfaces remain unverified.

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
- Under [ADR-0033](../adr/0033-better-auth-oauth-device-authorization.md), one
  app installation has one active endpoint-bound OAuth token bundle. Windows
  share that authorization while retaining independent presentation state.

## Implemented baseline

The checked-in application implements endpoint connection and Better Auth OAuth
device authorization:

- `NamaApp` creates one connection and OAuth authorization feature per window
  over one installation-wide authorization session and Keychain store. The
  session shares only non-secret active authorization status, expiry, and
  refresh/mutation admission; candidate codes, candidate failures, attempts,
  secret token material, and task lifetimes stay out of that observable shared
  state.
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
  allowlisted client name, version, and platform metadata. Permitted local HTTP
  uses an endpoint-scoped proxy-free configuration; HTTPS preserves the supplied
  normal configuration and system proxy behavior. The transport retains platform
  TLS trust, refuses every redirect before target contact, discards its location
  and response body, reports incompatible, and rejects streaming as
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
- The app declares `_nama._tcp`, its Local Network purpose, and the narrow ATS
  local-networking allowance in its partial Info property list without a
  multicast entitlement, arbitrary loads, or static per-domain exceptions. The
  macOS build uses App Sandbox with outgoing network-client access and the
  incoming-server capability required by `NamaPlayer`'s ephemeral broker. That
  broker binds only exact IPv4 loopback and exposes only opaque per-load routes;
  the entitlement does not authorize a product LAN listener.
- `OAuthAuthorizationFeature` requests the fixed Apple public client's device
  grant directly over native HTTP, presents CLI-only approval instructions,
  polls no faster than Better Auth's returned interval, proves the access JWT
  reaches the scoped `GetHome` authorization boundary, rotates refresh tokens
  at access-token expiry, and publishes authorization only after verification
  and the endpoint-bound bundle commit.
- `KeychainOAuthTokenStore` keeps one versioned exact-endpoint record with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and synchronization disabled.
  Damaged bytes are quarantined before removal; failed or cancelled candidate
  commits preserve the previous record.
- The OAuth HTTP adapter requests the exact Nama resource and consumer scopes
  plus `offline_access`, refuses redirects, and applies the connection module's
  proxy-free policy to acknowledged eligible local HTTP. Browser verification
  and Better Auth browser session routes are not part of this surface.
- `NamaPlayer` and `NamaPlayerSurface` contain exact-pinned AetherEngine
  `6.21.0` behind Nama-owned request, state, clock, track, video, control, and
  failure values. Each complete load owns one generation-guarded cancellable
  task and an ephemeral loopback broker. The broker gives AetherEngine only
  opaque local routes, refuses non-allowlisted initial and redirect targets,
  rewrites every HLS variant, rendition, segment, and key URI back through
  itself, and independently proxies external subtitles. Replacement and
  expiry stop and discard the previous broker, locator, headers, origins,
  tracks, rendering state, and stale observations before publishing or
  requesting the next load. The target and tests import no engine type outside
  that boundary. The complete Swift package closure is locked, notices are
  bundled, and the artifact and relinking review is recorded in
  [aetherengine-distribution.md](aetherengine-distribution.md).
- `NamaLibraryClient` is the concrete generated `LibraryService` adapter for
  both scoped-access verification and Home. It sends bearer and allowlisted
  client metadata, accepts `CATALOG_NOT_READY` as authenticated access, treats
  an unimplemented handler as incompatible, and maps generated summaries and
  Connect failures into Home-owned values and closed safe failures.
- `NamaLibraryClient` resolves opaque Home artwork references through
  `ResolveArtwork` and maps the response into app-owned locator values. Generated
  messages, URLs, headers, redirect origins, deadlines, and resolution failures
  remain below the presentation seam.
- One `HomeFeature` per window owns loading, catalog preparation, legitimate
  empty, content, refresh, refresh-failure, and initial safe-failure state.
  Refresh failure retains confirmed shelves with inline recovery. Endpoint or
  authorization identity replacement cancels the active load, and attempt
  identity prevents stale completion from publishing old media.
- One scene-local `HomeArtworkWindow` requests artwork only for visible media and
  a two-item lookahead, cancels obsolete work, rejects stale authorization or
  snapshot completions, and prunes decoded presentation state outside that
  window. Each card observes only its media-scoped presentation state. Home
  selects only textless posters and preserves the media title and neutral poster
  fallback for every absent or failed image.
- The shared `HomeArtworkLoader` validates HTTP(S) origins, scoped headers,
  redirect allowlists, refresh and access deadlines, status, and MIME type, and
  stops reading when the encoded byte limit is reached. It exposes only decoded
  `CGImage` presentation data, caches by artwork reference and stable size bucket
  under a decoded-cost LRU limit, purges on memory pressure, and invalidates on
  authorization identity changes.
- The scene root enters Home only when the published authorization belongs to
  its current endpoint. Home presents nonempty Movies before nonempty Shows,
  retains server item order, and offers explicit Retry, Refresh, and Change
  Endpoint actions. Authorize Again removes only the exact rejected bundle
  under OAuth mutation admission before the root starts a fresh device grant
  for the current endpoint. A storage failure moves the rejected status and
  generation into shared pending-discard state and clears active authorization
  so every window leaves Home. Storage-specific Retry resumes that exact
  discard rather than re-verifying the rejected token; damaged pending bytes
  are quarantined before device authorization restarts.

The Swift Testing target covers endpoint normalization and every approved and
forbidden address-class boundary, mapped and scoped IPv6, local DNS label and
name-length boundaries, and DNS-alias rejection. It also covers forbidden-HTTP
discovery suppression, TXT parsing, canonical candidate reconciliation,
duplicate and removal behavior, discovery lifecycle and timing, explicit
selection, endpoint preference contents, blocked legacy restoration, clearing,
generation and stale-completion races, explicit one-time restoration,
successful and failed restoration, local-HTTP confirmation and source-specific
cancellation, exact endpoint-bound acknowledgement, cross-window visibility,
partial and mismatched preference recovery, acknowledgement across failure and
Retry, verification replacement and cancellation, proxy selection, request
construction and client metadata, redirect refusal, unary-only transport
enforcement, safe failure mapping, state transitions, stale completions, long
endpoint presentation state, localized copy, warning semantics, presentation
actions, and television focus intent. Home coverage adds authorization routing,
rejected-bundle removal, endpoint and authorization-identity cancellation,
stale completion, refresh preservation and failure, catalog preparation,
response bounds and mapping, error precedence, consumer metadata, textless
poster selection, bounded visible lookahead, locator origin and redirect policy,
deadline enforcement, cancellation, safe decode failure, size-bucket caching,
authorization invalidation, stale resolution rejection, and memory-pressure
purging. Playback tests cover exact normalized origins, rejected initial and
redirect targets, allowed redirect header replay, nested HLS playlists, variants,
renditions, segments and keys, external subtitles, secret-free failures,
replacement cancellation and state discard, expiry signaling with a complete
replacement, surface removal, and foreground loss through the real adapter.

Self-contained previews render discovery outcomes, local-HTTP confirmation with
a long endpoint, persistent ready and failure warnings, blocked restoration,
and Home loading, empty, long-title content, refresh, catalog-preparation, and
failure fixtures. The Home loading, empty, long-title, and failure fixtures have
also run in the Debug application on iPhone, iPad, and Apple TV simulators and
an Apple Development-signed sandboxed Mac build. `check:ios` lints Swift
formatting, runs the test target through its macOS host, inspects the built ATS
shape, and performs signing-disabled iOS, tvOS, and macOS builds. The
real-player tests prove controlled SDR HLS rendering and control flow plus
adversarial locator and shared lifecycle policy through the real adapter on the
macOS host. Generic builds do not prove physical-device privacy prompts, focus,
accessibility, or playback.

This baseline implements endpoint eligibility, endpoint-bound persistent
local-HTTP consent, persistent selected-endpoint warnings, forbidden-HTTP
recovery, endpoint-scoped local-HTTP proxy bypass, the narrow ATS
local-networking allowance, Better Auth device authorization and refresh,
endpoint-bound Keychain tokens, provider-neutral Home over stored `GetHome`
results, and safe Home artwork resolution, loading, decoding, and fallback.
Library, Search, Details, Watch State, and Playback product behavior remain
unimplemented.

## Target runtime topology

The target topology keeps shared state narrow and makes each window and feature
own its lifecycle:

```text
NamaApp composition root
├── application session
├── one playback coordinator
├── endpoint and OAuth token stores
├── Better Auth OAuth and scoped Connect adapters
└── WindowGroup
    └── scene/window state
        ├── typed navigation and presentation
        └── feature owners
            └── narrow feature interfaces
                ├── Better Auth OAuth HTTP
                └── generated api.v1 networking adapters
```

### State lifetimes

| Lifetime | Owns | Never owns |
| --- | --- | --- |
| App installation | Current verified Nama endpoint, OAuth authorization availability and phase, endpoint-bound token bundle, and the single playback coordinator | Navigation, media collections, view errors, sheets, or control state |
| Scene or window | Typed navigation, sidebar or tab selection, sheets, selected opaque IDs, and feature-owner instances | OAuth tokens or another window's transient work |
| Feature | Its explicit state machine, loaded values, current operation identity, and structured tasks | Another feature owner or global presentation |
| View | Focus, field editing, disclosure, and animation triggers | Passed-in model ownership, networking, persistence, or business policy |

The application session is a narrow state module, not a view model for the
entire product. It exposes authorization availability and access-token expiry;
secret token material remains inside the installation-scoped OAuth token store
and authenticated networking adapters.

### Feature ownership

The source tree reserves these ownership directories for agent guidance. A
directory containing only `AGENTS.md` identifies target ownership; it does not
claim that the module compiles or runs:

| Module | Ownership |
| --- | --- |
| Application Session | Verified endpoint, OAuth authorization availability, authorization phase, and shared access-token expiry |
| Connection | Explicit LAN discovery, manual endpoint entry, verification, and last-verified endpoint persistence |
| OAuth Authorization | RFC 8628 request and polling, displayed CLI-approval code and instructions, endpoint-bound token commit, refresh, and revocation response |
| Home | Product entry composition, including Continue Watching when Watch state exists |
| Library | Provider-neutral browse, search, and bounded list loading |
| Details | Movie, show, season, and episode presentation plus watched and playback intents |
| Playback | Plan, open, control, report, close, and the sole playback-engine adapter |
| Watch State | Confirmed watched and resume behavior shared by Home, Details, and Playback |

Features expose typed values and user intents. The scene root handles
navigation and presentation intents; installation-scoped modules handle only
genuinely shared behavior. Details does not own Playback, OAuth Authorization
does not mutate Home, and no application event bus or notification-driven
control flow connects feature owners.
For Milestone 4, Details presents playability and source choice and emits a
typed playback intent. It does not plan, open, render, or control playback;
those responsibilities remain with Playback. Details exposes no watched or
resume behavior until Watch State exists, and browse acceptance does not depend
on executing the playback intent.

Networking, persistence, presentation, fixtures, and platform-specific files
stay with their owning feature while only that feature uses them. A
narrowly-named shared module appears only after two real callers require the
same semantics. A source seam does not require a Swift package: extract a local
package only after its interface is stable, its implementation is substantial
and independent of application scenes and resources, and measured build,
reuse, or test-isolation value justifies the package. The committed generated
`NamaAPI` package remains the intentional transport-edge package.

### Composition and dependency direction

`NamaApp` constructs the endpoint store, OAuth token store, concrete network
adapters, application session, and playback coordinator. Observable
installation state and the playback coordinator may use typed SwiftUI
environment injection where hierarchy-wide access is legitimate. Feature
clients are passed explicitly to feature-owner initializers; there is no
environment-backed dependency bag.

The dependency direction is:

```text
views -> feature owners -> narrow interfaces -> concrete adapters
                                             ├── Better Auth OAuth HTTP
                                             └── generated api.v1
```

The interface is the caller and test surface. Feature interfaces describe
behavior, cancellation, safe failures, and ordering constraints rather than
mirroring generated RPC methods. Home, Library, Details, and artwork loading use
narrow feature-specific interfaces over shared app-owned opaque media identity,
summary, artwork-reference, playability, and source-summary values. Details
projections, queries, page state, and failures remain feature-owned. One
concrete generated-client adapter may implement several feature interfaces, but
generated messages and Connect failures do not cross it. The core is the only
media data source in the MVP, so the application adds no generic repository
layer.

Milestone 4 browse delivery continues from the implemented Home and artwork
boundaries into Library/Search and Details/hierarchy/source behavior behind
their feature interfaces before scene-local navigation integrates them.
Universal actual-surface and stored-catalog acceptance closes the slice. This
sequence creates no platform-specific feature fork or empty package.

## Session, windows, and navigation

### One active authorization

One app installation has one active endpoint-bound OAuth token bundle.
Candidate endpoints may be verified in any window without attaching the active
access token or refresh token. Switching is an explicit replacement
transaction:

1. verify the candidate endpoint without attaching existing tokens;
2. request a Better Auth device authorization for the fixed public client,
   exact candidate resource, granular consumer scopes, and `offline_access`;
3. present the user code with instructions for an already authenticated CLI
   user to run `nama auth approve-device <user-code>` for their own access
   against the same endpoint, while polling no faster than the returned interval;
4. exchange the approved device code for access and refresh tokens;
5. durably store the complete endpoint-bound Keychain record; and
6. only then delete the old bundle and publish the new authorization.

Cancellation, denial, expiry, verification failure, or network loss before the
new durable commit leaves the active authorization intact. Endpoint similarity,
service name, certificate identity, or a similar response never permits token
replay against another resource or issuer.

The app treats Better Auth codes and tokens as opaque OAuth values. It uses the
returned polling interval and expiry, refreshes through the standard
refresh-token grant, and never invents a credential lifetime. The pinned target
defaults are one hour for access JWTs and 30 days for refresh tokens. A
definitive `invalid_grant`, expired refresh authority, or damaged token record
returns to visible device authorization; an ordinary offline failure preserves
the stored grant.

### Persistence and restoration

Connection and OAuth Authorization own two intentionally different records:

- The implemented `UserDefaults` record stores the last verified canonical
  Nama endpoint and, when applicable, its exact local-HTTP acknowledgement for
  unauthenticated reconnection convenience.
- The target Keychain record contains the exact canonical Nama endpoint,
  current access-token material and expiry, and rotating refresh token. It uses
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

A successful OAuth authorization writes the Keychain record before updating
the convenience endpoint. On launch, authorization comes entirely from the
Keychain record. Unknown, partial, damaged, or unauthenticatable record versions
fail closed into visible device authorization and are quarantined rather than
silently rewritten. Only explicit, tested migrations may transform a known
record version.

Launch uses an explicit restoration gate:

1. read and validate the endpoint-bound OAuth token record;
2. reverify that exact Nama endpoint without redirecting or attaching tokens;
3. use the current access token or rotate the refresh token through its exact
   issuer and resource; and
4. enter consumer content only after scoped authorization is usable.

With no device-local media cache, an offline authorized launch shows an
authorized-but-unavailable retry state rather than stale Home content. A
definitive refresh failure returns to device authorization while preserving the
last verified endpoint. Offline, timeout, TLS, server-unavailable, or transient
authentication failures preserve the token record. Broad Administrator
revocation becomes definitive on refresh; a previously issued access JWT may
remain usable until its one-hour expiry. The app never flashes Connection or
Home while restoration remains unresolved.

### Windows and navigation

`WindowGroup` supports multiple windows where iPadOS and macOS offer them.
Every window shares the installation authorization but owns its navigation,
selection, presentation, searches, and in-flight feature work. iPhone and Apple
TV naturally remain effectively single-window.

The semantic top-level destinations are Home and Library. Search is a
Library-owned mode, and selecting any Home, Library, Search, or child-list item
opens a typed Details destination. iPhone presents Home and Library in a
two-item `TabView`, while iPad and Mac use a `NavigationSplitView` sidebar and
content-detail selection. Compact iPad windows collapse to stack behavior.
Apple TV uses a focusable top-level Home and Library tab structure with a
navigation stack inside each destination. These containers preserve the same
feature intents and add no global router.

A newly authorized or unrestored window opens Home, whose Movies section
precedes Shows. A first direct Library visit selects Movies with
`TITLE_ASC`; restored state and Home's See All action override those defaults.

Each iPadOS or macOS window may restore its top-level destination, Library kind
and sort, and an optional selected opaque canonical item ID after scoped
authorization is re-established. The app reloads a selected item from the core.
Search mode and query clear on restoration. Forms, failures, results, page
tokens, generated messages, locators, artwork, playback plans, and playback
sessions are never restored. External deep links remain deferred until an
accepted ingress use case exists.

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

Each active feature loads once for its current endpoint, authorization identity,
selection, and query, preserves confirmed values during explicit refresh, and
cancels work when that identity changes. Returning to the foreground
revalidates only a visible previously loaded feature; it does not reload on
ordinary back navigation or trigger hidden polling. Search reruns only for a
user query, explicit refresh, or retry. An authorization-identity change
invalidates every value derived from the previous grant.

The Apple application schedules no catalog synchronization, reconciliation, or
general retries in the background; the core owns those responsibilities.
OAuth device-code polling, discovery, browsing, and token refresh run only
while their owner is active. Bounded background execution may be added only
for a demonstrated final playback checkpoint or token transition, not as a general
`BGTaskScheduler` framework.

Logical mutations create an `operation_id` once per user intent and retain it
with an identical payload across transport retries. A genuinely new user action
receives a new ID. Playback telemetry follows the contract's `event_id` and
sequence rules. Connect reads and other documented safe operations may retry
only within owned deadlines and `RetryInfo`. Better Auth device-code polling
and refresh follow its returned interval and OAuth errors; unsafe operations
never gain automatic retries merely because a generic client supports them.

## Connection target

Connection treats a Nama endpoint as a transport address, not deployment
identity. Changing endpoints always requires fresh verification and, once
authorized, a fresh OAuth device authorization.

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
endpoint is ready for OAuth authorization; `initialized=false` is a verified endpoint that
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

### Connection verification evidence

The implemented Connection boundary has these committed automated owners:

| Boundary | Automated owner | Covered behavior |
| --- | --- | --- |
| Endpoint eligibility | `EndpointTests` | Every approved IPv4 and IPv6 range and adjacent forbidden boundary, mapped IPv6, scoped link-local IPv6, proper local-name label and total-length boundaries, suffix lookalikes, trailing dots, public and special-use addresses, and DNS aliases remain lexical-only policy decisions. |
| Ingress admission | `ConnectionFeatureTests`, `DiscoveryTests`, and `ConnectionRecoveryTests` | Manual and restored forbidden HTTP never invoke the verifier; discovery cannot construct a candidate from forbidden HTTP; Retry and Continue cannot escape blocked restoration. |
| Consent and persistence | `ConnectionFeatureTests`, `ConnectionRecoveryTests`, `VerifiedEndpointStoreTests`, and `ConnectionPresentationTests` | Exact acknowledgement, source-specific cancellation, warning retention, migration, generation fencing, and cross-window visibility pass through the shared feature and store seams. |
| Transport | `SetupStatusVerifierTests` | Redirect targets are not contacted, redirect metadata stays inside URLSession, local HTTP selects a proxy-free copy, HTTPS preserves the supplied normal configuration, and cancellation reaches both schemes. Platform trust remains URLSession-owned; the redirect delegate implements no authentication-challenge override. |
| Application declarations | `check:ios` | Built iOS, tvOS, and macOS property lists must enable only ATS local networking and must omit arbitrary loads and static exception domains. |
| OAuth authorization and persistence | `OAuthAuthorizationFeatureTests`, `OAuthAuthorizationLifecycleTests`, `OAuthAuthorizationTransportTests`, and `OAuthTokenStoreTests` | Concrete native OAuth and scoped Connect requests, returned-interval polling, expiry-driven refresh, structured retry, window-local task cancellation, shared refresh admission and takeover, serialized mutation rollback, replacement publication ordering, damaged-record quarantine, and this-device-only non-synchronizing Keychain attributes are specified through deterministic seams. |

The previews and platform builds above remain inspection and compilation aids,
not runtime evidence. Local acceptance has exercised only the scenarios
recorded below; every omitted requirement remains **Unverified**.

The signed Apple TV 4K simulator authorization result below is simulator
actual-surface evidence. It is not physical-device privacy, ATS, LAN,
proxy-routing, remote-control, or Keychain-hardware proof. Actual-surface
inspection on the remaining rows and expiry-driven refresh remain required.

| Surface | Required inspection | Recorded result |
| --- | --- | --- |
| iPhone | Confirmation, persistent warning, blocked restoration, long endpoint, touch and keyboard focus, Dynamic Type, VoiceOver labels and order, contrast, and non-color-only meaning | **Partially verified** — an iPhone 17 Pro simulator rendered blocked restoration and the persistent failed local-HTTP warning with a long endpoint. The warning remained legible through the largest Dynamic Type category with Increase Contrast enabled and communicated its meaning through text and symbol. Confirmation, input focus, operation, and VoiceOver order remain **Unverified**. |
| iPad | The iPhone inspection plus window resizing and cross-window policy behavior | **Partially verified** — an iPad Pro 13-inch simulator rendered the persistent failed local-HTTP warning and long endpoint without clipping. The remaining inspection is **Unverified**. |
| Apple TV | Confirmation, persistent warning, blocked restoration, long endpoint, remote focus and operation, VoiceOver labels and order, contrast, and non-color-only meaning; Dynamic Type is not applicable | **Partially verified** — a signed Apple TV 4K simulator confirmed acknowledged local HTTP against a live Nama server, displayed the device code, completed generated-CLI approval and native token exchange, reached the scoped consumer boundary, committed the endpoint-bound Keychain bundle, and restored authorization after relaunch. Expiry-driven refresh, foreground cancellation, blocked restoration, physical-remote operation, and VoiceOver order remain **Unverified**. |
| Mac | Confirmation, persistent warning, blocked restoration, long endpoint, keyboard and pointer focus, window and cross-window behavior, Dynamic Type, VoiceOver labels and order, contrast, and non-color-only meaning | **Partially verified** — a locally Apple Development-signed sandboxed build on Mac hardware rendered confirmation, approved local HTTP against a live Nama server, the resulting setup-required warning, and the failed long-endpoint state. The accessibility tree exposed the visible labels and actions. Blocked restoration, keyboard and pointer focus, cross-window behavior, Dynamic Type, and VoiceOver order remain **Unverified**. |

Simulator behavior, shared source, and built declarations are not Local Network
privacy, ATS, LAN, or proxy-routing proof. Physical iPhone, iPad, and Apple TV
hardware were unavailable for this acceptance run and remain explicitly
**Unverified**:

| Hardware | Required runtime exercise | Recorded result |
| --- | --- | --- |
| Physical iPhone | `_nama._tcp` discovery, approved local HTTP, manual HTTPS and HTTP for LAN, VPN, and reverse-proxy deployments, and Local Network allow, deny, and later-Settings behavior | **Unverified** |
| Physical iPad | `_nama._tcp` discovery, approved local HTTP, manual HTTPS and HTTP for LAN, VPN, and reverse-proxy deployments, and Local Network allow, deny, and later-Settings behavior | **Unverified** |
| Apple TV | `_nama._tcp` discovery, approved local HTTP, and manual HTTPS and HTTP for LAN, VPN, and reverse-proxy deployments; the iPhone/iPad Local Network prompt is not exposed | **Unverified** |
| Mac hardware | `_nama._tcp` discovery, approved local HTTP, manual HTTPS and HTTP for LAN, VPN, and reverse-proxy deployments, and exposed Local Network privacy behavior | **Partially verified** — a native Nama publisher advertised the exact local HTTP endpoint through Apple `NWBrowser`; the signed sandboxed app confirmed that endpoint, contacted its live `SetupService`, and displayed the setup-required result with the persistent HTTP warning. Manual HTTPS, VPN and reverse-proxy HTTP, and Local Network privacy-state behavior remain **Unverified**. |

## Networking, compatibility, and failures

The composition root creates concrete adapters over generated Connect clients
and Better Auth's OAuth HTTP contract. Connection verification, OAuth
Authorization, Library, Playback, and Watch State expose narrow interfaces
that accept and return app-owned values. There is no broad public `NamaClient`,
generated-message environment value, or handwritten parallel OAuth client.

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

Nama-owned structured logging uses allowlisted fields and categories owned by
each feature or adapter. It never contains request or response bodies,
arbitrary headers, credentials, polling tokens, raw generated messages,
unrestricted endpoint input, locator material, or provider failures.
[ADR-0032](../adr/0032-aetherengine-mvp-security-exception.md) permits the
selected engine's own local Release logs to contain complete short-lived
locator URLs during the MVP; the app never persists, uploads, or exposes those
engine logs. No analytics or telemetry backend is added without a current
accepted use case.

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

Milestone 4 Library browsing exposes one persistent Movies-or-Shows selection
and offers the contract's title, release-date, and date-added sorts. Genre,
release-year, and playable-only controls remain unexposed until a concrete
navigation need justifies them.

Search covers movies, shows, seasons, and episodes. It trims input, starts a
request after an approximately 300-millisecond debounce for any nonempty query,
cancels obsolete requests, and returns to an idle state when cleared. Results
preserve server ranking and order.

Home item selection opens Details. Each section's See All action opens Library
with the matching kind and `DATE_ADDED_DESC` sort. An empty section is omitted;
when both sections are empty, Home presents one empty state.

Browsing follows the canonical hierarchy one level at a time: Show Details
lists seasons, Season Details lists episodes, and Episode Details is independently
addressable. A direct season or episode Search result opens its own Details
surface with canonical parent context.

Home presents bounded horizontal media shelves, Library uses an adaptive poster
grid, and mixed-kind Search uses information-rich rows that expose kind, year,
and available season or episode position. Lean summaries contain no parent
references; canonical parent names load only after the person opens Details.

Movie, show, and season collections prefer poster artwork; episode rows prefer
thumbnails. Details may combine a backdrop and poster, while only credits use
portraits. Textless artwork is preferred. A logo may support the composition
but never replaces the rendered title or accessibility label. Missing artwork
uses a quiet title-bearing placeholder with stable dimensions.

Details begins with canonical identity, artwork, and concise metadata. A
playable movie or episode then presents its primary Play action, followed by
synopsis and supporting metadata. A show or season makes its canonical children
the primary continuation. Genres, credits, studios, and technical source
inspection remain subordinate and load only when their surface needs them.

Details keeps Directors and Writers visible as concise metadata and presents a
bounded ordered Cast row with portraits when available. See All reveals the
complete ordered credits without a modal. Long synopsis text may expand in
place without displacing Play or canonical children from the initial task
hierarchy.

Home, browse, search, and child lists consume lean summaries. Details and
technical source values load only when their surface requires them. Large lists
use bounded server-driven pages or continuation tokens once the public contract
supplies them. Each feature owns page state per session and query, preserves
server order, deduplicates only by opaque Nama identity, cancels obsolete page
requests, and retries a failed page without discarding confirmed pages.

Touch and pointer surfaces request the next page when the person approaches the
end of confirmed content. Apple TV presents a stable focusable Load More item
instead. Both invoke the same page intent; appended items retain identity and
server order, and loading or failure appears after confirmed content without
stealing selection or focus.

A playable movie or episode's primary Play action uses its canonical default
source. Details exposes a typed Sources child destination when multiple source
summaries exist or the default is unavailable. That destination presents
neutral quality and availability, loads selected source parts and tracks only
on demand, and returns an explicit opaque source ID in the playback intent only
after deliberate selection. It is not a modal, menu, or inline dump of every
technical value.

Play appears only for `PLAYABLE`. `TEMPORARILY_UNAVAILABLE` replaces it with an
explanatory status and Retry, while `NO_AVAILABLE_SOURCE` presents “No playable
source” without a dead control. Collection items retain a concise availability
indicator rather than hiding the canonical item.

Artwork views receive no locator URL. A Nama-owned artwork loader accepts an
artwork reference and requested size bucket, resolves and fetches within the
locator security policy, and returns decoded presentation data. It loads
visible artwork plus a small scroll lookahead, retains a decoded-cost-limited
memory cache keyed by artwork reference and size bucket rather than locator,
and purges on memory pressure or authorization-identity change. Work outside
the useful lookahead is canceled; backdrops and portraits load only when their
Details region becomes relevant. Persistent `URLCache` or disk image caching
requires a later design for retention, secret-bearing cache keys, invalidation,
and offline behavior.

`CATALOG_NOT_READY` presents a dedicated loading state using the server's retry
guidance and an explicit Retry action; a legitimately empty Library presents a
distinct empty state. A later-page failure retains confirmed items and offers
inline Retry. Provider or source unavailability remains local playability
information rather than a global blocker. Missing or unsafe artwork falls back
to the mandatory title without failing the containing item.

Search idle presents “Search your library” and names movies, shows, seasons,
and episodes. An empty result presents “No results for ‘…’” with Clear Search;
a Search failure presents “Search is unavailable” with Try Again while
preserving the query. Initial catalog import presents “Your library is being
prepared,” while a legitimate empty catalog presents “Your library is empty”
with Refresh and no unauthorized provider-management action.

Ordinary initial loads use static redacted placeholders shaped like the final
shelves, grid items, rows, or Details regions rather than replacing the surface
with a central spinner. They use no perpetual shimmer. Later-page progress stays
inline below confirmed items, and state transitions remain short,
reduced-motion-safe, and structural rather than decorative.

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
gestures. Apple TV initially focuses the first actionable item in the first
nonempty section, restores selection by opaque canonical item ID when returning
from Details, falls back to the nearest surviving sibling, and never lets page
insertion steal focus. Mac exposes conventional Home, Library, Search, Refresh,
and Back commands rather than hidden gestures. Self-contained previews cover
meaningful loading, empty, content, long-content, pending, and failure states
without live services or credentials.

## Playback boundary

[ADR-0012](../adr/0012-single-playback-engine-adapter.md) confines AetherEngine
`6.21.0` to one concrete Nama-owned adapter. The module containing `NamaPlayer`
and its `NamaPlayerSurface` is the only one allowed to import the engine.
Engine views, publishers, tracks, cues, errors, and configuration types never
cross into another feature or the public RPC layer.

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

A locator expiry is not refreshed inside the engine. The coordinator closes the
old playback session, replans and opens at the current clamped position, and
supplies one complete replacement request; the newer load owns all locator,
header, redirect, track, and rendering state.

[ADR-0032](../adr/0032-aetherengine-mvp-security-exception.md) selects
AetherEngine `6.21.0` and requires its exact source revision and complete
resolved dependency closure to remain pinned. The adapter adds neither a
lowest-common-denominator player interface nor a multi-engine factory.

### Locator and logging invariants

[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md) establishes the
direct-delivery security boundary. Media travels directly from the provider to
the client. The core is not a media relay, and an on-device loopback bridge used
by a player does not change that boundary.

The production adapter places every remote media and external-subtitle request behind one session-scoped loopback bridge. AetherEngine receives only opaque loopback locators and no upstream Locator headers. The bridge retains upstream Locator material in session memory, validates every destination, rewrites HLS child references, and ends with the load that owns it.

- Nama-owned Locator values and headers are session-memory-only. Never persist,
  upload, or place them in Nama-owned logs, errors, analytics, diagnostics,
  metadata, defaults, or Keychain. ADR-0032 permits the selected engine's local
  Release logs to contain complete short-lived Locator URLs, but the production
  adapter supplies only opaque loopback URLs.
- Follow only origins present in the core-validated
  `allowed_redirect_origins` allowlist. Each value is an exact normalized
  scheme/host/effective-port origin. The bridge rejects an initial Locator,
  redirect, playlist, variant, rendition, segment, key, or subtitle destination
  whose origin is absent.
- Locator headers remain inside the bridge and are attached only to upstream
  requests whose destinations are in that Locator's allowlist. AetherEngine
  receives no upstream Locator headers.
- The core never supplies Administrator sessions, OAuth access or refresh
  tokens, or reusable provider-account credentials in a locator. Normalize
  engine and network failures into a closed, secret-free Nama error model.

The session bridge is mandatory containment because AetherEngine `6.21.0`
cannot enforce Nama's origin allowlist itself. An engine or adapter that permits
a destination outside the validated allowlist remains ineligible. ADR-0032's
Release-log and allowed-origin header-replay exceptions are ceilings, not
permission to bypass the bridge or make another Locator rule advisory.

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

Before product playback depends on AetherEngine:

1. Pin `6.21.0` and its complete resolved dependency closure. Record source and
   artifact checksums, build configuration, and the two accepted ADR-0032
   limitations.
2. Keep engine imports confined to `NamaPlayer` and `NamaPlayerSurface`, and
   test the complete Nama-owned request, state, clock, lifecycle, track,
   rendering, replacement-load, and failure mapping.
3. Play one known-good SDR HLS fixture through `NamaPlayer` on representative
   physical iPhone or iPad, Apple TV, and Mac hardware. Issue #39 owns
   capability and fallback evidence; issue #40 owns the full media and
   interaction matrix.
4. Inspect Release logs and network captures on every supported platform.
   Record the accepted local locator-URL logging and allowed-origin header
   replay, and verify there is no request to a non-allowlisted destination,
   Nama-owned locator logging, persistence, upload, or locator-bearing user
   error.
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
- persistence-adapter tests cover endpoint normalization, endpoint-token
  binding, replacement commit ordering, known-version migration, refresh
  rotation, and damaged records;
- artwork and playback tests cover origin/header policy, cancellation, mapping,
  lifecycle, and redaction without treating generated round trips as product
  behavior; and
- deterministic previews cover visual states without live network, Keychain,
  or provider dependencies.

Provider-neutral browse acceptance additionally requires:

- feature tests for load, replacement cancellation, stale completion, Search
  debounce, paging and retry, refresh, empty and failure states, and
  identity-based selection and focus;
- adapter and artwork tests for every consumed generated request and response,
  validation bounds, authorization and safe failure mapping, scoped headers,
  redirects, expiry, cancellation, memory pressure, title fallback, and absence
  of generated or provider values beyond the adapter;
- deterministic previews for loading, catalog preparation, legitimate empty,
  content, long content, no results, later-page failure, unavailable source,
  and missing artwork;
- actual-surface inspection on iPhone and iPad simulators, Apple TV simulator
  with focus interaction, and an Apple Development-signed sandboxed Mac app;
  and
- one real flow on every supported app presentation through OAuth-authorized
  production clients, the production server, PostgreSQL, supervised production
  Jellyfin catalog import, public `LibraryService`, Home, Library, Search,
  movie/show/season/episode Details, source inspection, and artwork fetch.

The browse slice ends after the Details feature emits a verified typed playback
intent; it does not plan, open, render, or control playback. Physical-device
playback, Local Network privacy, and playback-engine evidence remain explicitly
unverified here and belong to their owning acceptance work.

UI automation is added only when a critical interaction cannot be defended
reliably through a module interface and actual-surface verification. Platform
builds remain compile evidence. Real OAuth device authorization, focus,
navigation, local-network privacy, accessibility, playback, and lifecycle flows
run on each affected surface. No unrun hardware, provider, security, or
accessibility row is reported as passing.

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
