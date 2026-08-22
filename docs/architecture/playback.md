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

[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md) requires provider
media and short-lived authorization to travel directly to the client, never
through the core or into logs or persistence. The selected engine must enforce
exact-origin locator headers on redirects and every HLS subrequest and produce
secret-free Release logs and errors.

[ADR-0014](../adr/0014-four-stage-playback-lifecycle.md) defines the
plan, open, report, and close lifecycle for the target public and plugin
contracts.

Before product playback adopts an engine, Nama must inspect the exact pinned
source revision; pass representative physical iPhone or iPad, Apple TV, and Mac
media tests; and complete artifact-level distribution review.
