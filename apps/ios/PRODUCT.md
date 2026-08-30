# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

People who operate a private Nama deployment and need to connect an iPhone,
iPad, Apple TV, or Mac from the device in front of them. Their immediate job is
to discover, enter, or restore a Nama endpoint, authorize scoped consumer
access, browse stored canonical Movies and Shows, search stored media across all
four canonical kinds, and move through canonical Details toward a typed Play
intent.

## Product Purpose

Nama's universal Apple application provides one native, dependable client
across Apple platforms. Its connection and authorization flow turns an
explicitly discovered, manually entered, or restored transport address into a
verified Nama endpoint and one endpoint-bound OAuth grant without guessing
identity or weakening platform security. Home presents bounded provider-neutral
stored media through the public `LibraryService`; Library adds exhaustive
server-ordered Movie and Show pages with native sort, navigation, and recovery.
Library-owned Search debounces trimmed queries, preserves the server's ranking
across Movies, Shows, Seasons, and Episodes, and pages mixed-kind summaries
without provider queries or parent enrichment. Home, Library, Search, and
Details resolve safe textless canonical artwork through signed Nama-owned
locators without exposing locator details to views.
Details loads Movies and Shows, pages from Shows to Seasons and Seasons to Episodes, preserves
canonical parent context, and conditionally opens a provider-neutral Sources
destination. Primary Play leaves the available canonical default implicit; a
deliberate Source choice loads technical details on demand and emits an
app-owned Play intent with its opaque canonical source ID. Neither path invokes
playback. A complete provider-issued player request can be rendered through the
native loading, transport, seek, Track-selection, completion, safe-failure, and
return-to-Details presentation, but the public planning/opening coordinator and
Watch State remain unimplemented.

## Positioning

Nama is a native, provider-neutral Apple client that safely turns a selected
self-hosted endpoint into verified, scoped access—without a browser,
provider-specific surface, or hidden setup state.

## Operating Context

People use the app on the Apple device they want to connect. They explicitly
discover, enter, or restore one Nama endpoint, acknowledge an eligible local
HTTP connection when required, and verify its setup status. Device
authorization is approved through the signed-in Nama CLI on a trusted computer;
the app then continues automatically.

## Capabilities and Constraints

The current app supports connection, endpoint restoration, foreground LAN
discovery, eligible local-HTTP acknowledgement, device authorization, refresh
rotation, endpoint-bound Keychain storage, Home, exhaustive paginated Movie and
Show Library browsing, debounced all-kind Search over stored canonical media,
safe artwork, canonical Movie, Show, Season, and Episode Details, and on-demand
canonical Source inspection on iOS, iPadOS, tvOS, and macOS. It presents one
active endpoint-bound consumer authorization. Playable Movie and Episode
Details emit only a typed canonical Play intent, optionally carrying a
deliberately chosen opaque source ID. The standalone playback presentation
accepts one complete request and adapts its controls to touch, pointer, keyboard,
and remote focus; provider management, public playback execution from Details,
and Watch State are not current app behavior.

## Brand Commitments

Calm, direct, trustworthy. Nama feels native to each Apple platform, makes
self-hosting understandable, and communicates failures without exposing
implementation detail or creating alarm. It must not resemble an integration
dashboard, ornamental setup wizard, generic card grid, or provider-branded
client. Avoid decorative Liquid Glass, hidden gestures, speculative Home or
authorization placeholders, raw networking diagnostics, and custom controls
where a standard platform control already communicates the action.

## Evidence on Hand

The current implementation contains native connection, OAuth authorization,
Home, Library, Search, media Details, and Sources views with self-contained
loading, content, recovery, long content, missing artwork, unavailable sources,
canonical children, later-page failure, normalized technical details, distinct
unlabeled Source choices, and stale Source recovery. `DESIGN.md` records the
native system presentation rules. Library fixtures rendered the two-item iPhone
and Apple TV tabs, the iPad split sidebar, adaptive long-title grids, terminal
content, and Apple TV’s visible Load More action on iPhone 17 Pro, iPad Pro
13-inch, and Apple TV 4K simulators. Search fixtures rendered ranked all-kind
rows with a long Episode title, missing-artwork fallbacks, kind, year, Episode
position, and playability metadata on iPhone 17 Pro, iPad Pro 13-inch (M5),
Apple TV 4K 1080p, and Apple Development-signed sandboxed Mac surfaces. Simulated
touch selected the long Episode on iPhone, cleared no-results on iPad, and
activated iPad catalog-preparation recovery with its retry guidance intact.
Apple TV remote focus activated Load More and Retry Page and returned to the
first result. The static loading surface remained onscreen on Apple TV and Mac,
and full keyboard access selected the long Episode on Mac.
An Apple Development-signed sandboxed Mac build created an onscreen Library
window, but pixel capture and Library keyboard or pointer inspection were
unavailable. The unlabeled Sources fixture ran on iPhone 17 Pro and iPad Pro
13-inch (M5) simulators, an Apple TV 4K (3rd generation) simulator, and an Apple
Development-signed sandboxed Mac build. Those runs confirmed distinct Source 1
and Source 2 actions and matching technical titles through simulated touch,
Apple TV remote focus and selection, and Mac pointer and keyboard operation.
The controlled playback presentation rendered on iPhone 17 Pro and iPad Pro
13-inch (M5) simulators, an Apple TV 4K 1080p simulator, and an Apple
Development-signed sandboxed Mac build. Touch paused, sought, and used both
Track surfaces; Apple TV remote input traversed transport and Track focus,
paused, and confirmed subtitle selection; Mac pointer input paused and opened
the correctly sized Track sheet, while full keyboard access reached its action.
Its safe network failure retained visible return-to-Details recovery.
A later signed sandboxed Mac run rendered unknown-duration chrome with an
accessibility-tree elapsed value of `0:00:00` and an explicit
player-initialization-unavailable preview state instead of a blank canvas.
A paired physical iPhone 14 Pro Max accepted the signed build but denied launch while
locked; physical playback input and display were not observed.
Issue #180 rendered a fresh OAuth-authorized production catalog on signed
iPhone 17 Pro, iPad Pro 13-inch (M5), and Apple TV 4K simulators. The original
run showed Home, Movie Library, Movie/Show/Season/Episode Details, canonical
children, and Apple TV focus movement into Library. A follow-up run installed a
fresh endpoint-bound grant through a temporary DEBUG-only harness and drove
every browse RPC from the app process through `NamaLibraryClient` and the
generated Swift public client: all three Library sorts, continuation paging,
all-kind Search, every Details kind, both hierarchy levels, Movie and Episode
Source inspection and artwork resolution. The app-owned artwork path fetched
and decoded the representative image. ADR-0035 subsequently moved that image
behind a signed Nama-owned locator backed by the bounded canonical asset stored
during catalog ingestion, so no provider locator material reaches the app.
The same native flow mapped Movie and Episode Details, inspected the Episode
Source through `MediaSourcesFeature`, resolved and decoded artwork, and emitted
a source-specific typed Play intent without a playback-planning or opening
dependency. iPhone production Home was also inspected at the largest
accessibility text size with increased contrast and reduced motion enabled.
Termination and relaunch restored the authorized production Home; the temporary
harness and authorization records were then removed.
Issue #235's follow-up repeated the OAuth-authorized production flow on signed
iPhone 17 Pro, iPad Pro 13-inch (M5), and Apple TV 4K (3rd generation)
simulators. Touch and keyboard input exercised Home, both Library kinds,
all-kind Search, decoded canonical artwork, Movie/Show/Season/Episode Details,
canonical children, Episode Source inspection, and default and source-specific
typed Play intents. Apple TV keyboard and remote input selected Search results,
moved through Show → Season → Episode, focused Play, activated an explicit
Details Back action, restored focus to the Episode row, inspected the canonical
Source, and focused and activated Play This Source. The run exposed that lazy
Details rows and toolbar-only Refresh left the remote focus engine without an
onscreen content target; Details now materializes its bounded actions eagerly,
assigns the first actionable focus explicitly, and keeps Refresh in the tvOS
content flow. The temporary token and forced-Source harness was removed.

The pre-cleanup Mac production-catalog run exercised Home, both Library kinds,
typed Search, every Details kind, hierarchy, and keyboard and pointer input; its
exact Source route depended on a temporary DEBUG-only ID route, so it is
supporting evidence rather than final-artifact acceptance. After every harness
was removed, the final tree built with an Apple Development authority and the
expected sandbox, client-network, and loopback-server entitlements. Under the
current locked desktop graphical session, launching that artifact created a Nama
process with zero windows, so the required permanent-artifact
browse/search/details/source flow remains unverified.

The production-backed Apple TV run did not exercise Load More or Retry recovery.
VoiceOver previously activated on the live Home window and captioned its toolbar
focus, but representative labels, reading order, action names, and focus order
across Home, Library/Search, Details, and Sources remain unverified. Compact iPad
collapse, expiry-driven actual-surface refresh, and physical Apple hardware also
remain unverified.

## Product Principles

- Preserve the task hierarchy: connection precedes authorization, Home and Library precede Details, and a Play intent precedes playback execution.
- Earn trust with honest terminal states and safe, specific recovery actions.
- Follow native platform presentation and focus behavior while sharing one feature model.
- Keep transport and generated API details at the networking edge.
- Prefer familiar, accessible controls and quiet hierarchy over decoration.

## Accessibility & Inclusion

Support Dynamic Type, VoiceOver labels and reading order, keyboard and remote
focus, high-contrast system colors, long endpoints, and reduced-motion
preferences through standard SwiftUI behavior. No critical action may depend on
an undiscoverable gesture, color alone, or a platform-specific interaction
unavailable on another supported surface.
