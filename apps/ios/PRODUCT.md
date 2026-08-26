# Product

## Register

product

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
stored media through the public `LibraryService`. Library browsing, Search,
Details, artwork loading, Watch State, and Playback remain unimplemented.

## Brand Personality

Calm, direct, trustworthy. Nama should feel native to each Apple platform, make self-hosting understandable, and communicate failures without exposing implementation detail or creating alarm.

## Anti-references

Do not resemble an integration dashboard, ornamental setup wizard, generic card grid, or provider-branded client. Avoid decorative Liquid Glass, hidden gestures, speculative Home or authorization placeholders, raw networking diagnostics, and custom controls where a standard platform control already communicates the action.

## Design Principles

- Put the current task first: connect and verify one endpoint before introducing later product capabilities.
- Earn trust with honest terminal states and safe, specific recovery actions.
- Follow native platform presentation and focus behavior while sharing one feature model.
- Keep transport and generated API details at the networking edge.
- Prefer familiar, accessible controls and quiet hierarchy over decoration.

## Accessibility & Inclusion

Support Dynamic Type, VoiceOver labels and reading order, keyboard and remote focus, high-contrast system colors, long endpoints, and reduced-motion preferences through standard SwiftUI behavior. No critical action may depend on an undiscoverable gesture, color alone, or a platform-specific interaction unavailable on another supported surface.
