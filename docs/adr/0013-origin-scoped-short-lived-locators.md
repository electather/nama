# Deliver media directly with origin-scoped short-lived locators

Status: superseded for canonical artwork by [ADR-0035](0035-nama-owned-canonical-artwork-assets.md) and in part for the Apple playback MVP by [ADR-0032](0032-aetherengine-mvp-security-exception.md).

Nama does not relay playable media or expose reusable provider credentials. It gives clients narrowly scoped playable-media locators whose headers apply only to the exact origin and whose redirects are allowlisted; a provider that cannot meet those constraints fails playback rather than becoming an implicit proxy. ADR-0035 separately makes bounded canonical artwork a Nama-stored catalog asset. The added client and provider constraints preserve direct playback without turning credentials into portable access.

## Considered option

AetherEngine `6.21.0` was rejected: source review and the retired feasibility experiment found complete locator URLs in Release logging and cross-origin replay of unrecognized custom headers. Source review of Sodalite's newer integration found the same trust-boundary failures; its GPL application code is design evidence, not source to copy. The experiment supplied useful rendering, seeking, audio/subtitle selection, HDR, and lifecycle evidence, but did not approve an engine or prove physical-device product behavior.
