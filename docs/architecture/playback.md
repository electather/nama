# Playback

Status: the universal Apple application contains the production `NamaPlayer`
boundary backed by exact-pinned AetherEngine `6.21.0`. Automated macOS-host
verification loads, renders, controls, and stops controlled media through the
real adapter. Public planning, opening, reporting, and closing remain target
architecture.

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

[ADR-0014](../adr/0014-four-stage-playback-lifecycle.md) defines the
plan, open, report, and close lifecycle for the target public and plugin
contracts.

The integration pins AetherEngine's exact source revision and complete resolved
dependency closure and confines its rendering and control types to
`NamaPlayer`. The [distribution record](aetherengine-distribution.md) owns the
reviewed build, linkage, checksum, notice, source, signing, and relinking
evidence. Issue #161 proves a controlled SDR HLS fixture through the real
adapter in automated macOS-host verification. Issue #38 still owns
representative physical iPhone or iPad, Apple TV, and Mac playback evidence;
capability negotiation and the full media and interaction matrix remain with
issues #39 and #40.
