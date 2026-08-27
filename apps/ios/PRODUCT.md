# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

People who operate a private Nama deployment and need to connect an iPhone,
iPad, Apple TV, or Mac from the device in front of them. Their immediate job is
to discover, enter, or restore a Nama endpoint, authorize scoped consumer
access, and see stored canonical Movies and Shows in Home with honest loading,
empty, preparation, content, refresh, and failure states.

## Product Purpose

Nama's universal Apple application provides one native, dependable client
across Apple platforms. Its connection and authorization flow turns an
explicitly discovered, manually entered, or restored transport address into a
verified Nama endpoint and one endpoint-bound OAuth grant without guessing
identity or weakening platform security. Home then presents provider-neutral
stored media through the public `LibraryService` and resolves safe textless
poster artwork without exposing locator details to views. Library browsing,
Search, Details, Watch State, and Playback remain unimplemented.

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
rotation, and endpoint-bound Keychain storage on iOS, iPadOS, tvOS, and macOS.
It presents only one active endpoint-bound consumer authorization. Provider
management, Home, Library, Details, Watch State, and product media behavior are
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

The current implementation contains native connection and OAuth authorization
views with SwiftUI previews for discovery, local-HTTP confirmation, ready,
failure, and blocked-restoration states. The product has no committed visual
token system or DESIGN.md; future work must not invent commercial proof,
provider-specific material, or implemented media behavior.

## Product Principles

- Put the current task first: connect and verify one endpoint before introducing later product capabilities.
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
