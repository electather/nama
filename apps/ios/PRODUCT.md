# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

People who operate a private Nama deployment and need to connect an iPhone,
iPad, Apple TV, or Mac from the device in front of them. Their immediate job is
to discover, enter, or restore a Nama endpoint, authorize scoped consumer
access, browse stored canonical Movies and Shows in Home, and move from a Movie
or Show through the canonical Details hierarchy toward a typed Play intent.

## Product Purpose

Nama's universal Apple application provides one native, dependable client
across Apple platforms. Its connection and authorization flow turns an
explicitly discovered, manually entered, or restored transport address into a
verified Nama endpoint and one endpoint-bound OAuth grant without guessing
identity or weakening platform security. Home then presents provider-neutral
stored media through the public `LibraryService` and resolves safe textless
artwork without exposing locator details to views. Details loads Movies and
Shows, pages from Shows to Seasons and Seasons to Episodes, preserves canonical
parent context, and conditionally opens a provider-neutral Sources destination.
Primary Play leaves the available canonical default implicit; a deliberate
Source choice loads technical details on demand and emits an app-owned Play
intent with its opaque canonical source ID. Neither path invokes playback.
Library browsing, Search, Watch State, and playback execution remain
unimplemented.

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
rotation, endpoint-bound Keychain storage, Home, safe artwork, canonical Movie,
Show, Season, and Episode Details, and on-demand canonical Source inspection on
iOS, iPadOS, tvOS, and macOS. It presents one active endpoint-bound consumer
authorization. Playable Movie and Episode Details emit only a typed canonical
Play intent, optionally carrying a deliberately chosen opaque source ID;
provider management, Library, Search, Watch State, and playback execution are
not current app behavior.

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
Home, media Details, and Sources views with self-contained previews for
loading, content, recovery, long content, missing artwork, unavailable sources,
canonical children, later-page failure, normalized technical details, and stale
Source recovery. `DESIGN.md` records the native system presentation rules.
Show, Season, and Episode fixtures have run in the Debug application on iPhone
17 Pro, iPad Pro 13-inch, and Apple TV 4K simulators and an Apple
Development-signed sandboxed Mac build. Those runs confirmed kind-specific
titles and metadata, title-bearing artwork fallbacks, canonical parent context,
Season and Episode child rows, long child titles, and Episode Play. Sources has
not been inspected on Mac, iPhone, iPad, or Apple TV with keyboard, pointer,
touch, or remote focus. Apple TV Load More focus interaction, focus return
after nested Details, the live OAuth-authorized stored-catalog hierarchy,
successful artwork resolution, and physical Apple hardware remain unverified
actual surfaces.

## Product Principles

- Preserve the task hierarchy: connection precedes authorization, Home precedes Details, and a Play intent precedes playback execution.
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
