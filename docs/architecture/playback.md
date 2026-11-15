# Playback

Status: the universal Apple application has a manual-connection tracer;
playback remains target architecture and no production playback engine is
implemented.

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
dependency closure, confines its rendering and control types to `NamaPlayer`,
and completes artifact-level distribution review. Issue #38 proves one
known-good SDR HLS fixture on representative physical iPhone or iPad, Apple TV,
and Mac hardware; capability negotiation and the full media and interaction
matrix remain with issues #39 and #40.
