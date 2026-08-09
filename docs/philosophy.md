# Nama Product Philosophy

Nama exists to give people one coherent way to find, watch, and manage media they control, regardless of which services supply it.

This document defines the product aim and the principles used to judge product decisions. It deliberately avoids implementation choices. See [architecture.md](architecture.md) for the technical requirements that realize these goals.

## Aim

Self-hosted media is fragmented. Libraries, metadata, playback, acquisition, and user state often live in separate services with different concepts and interfaces. Nama should turn those parts into one understandable product.

People should interact with movies, shows, requests, and their own activity—not with provider-specific identifiers, schemas, or workflows. Connecting or replacing a provider should not require relearning the product.

The long-term aim is:

> A private, self-hosted media experience whose capabilities can come from existing services, first-party implementations, or third-party extensions without changing how the product feels to its users.

## Product principles

### One product, not a dashboard of integrations

Nama should present a unified library and consistent workflows. Integrations supply capabilities; they do not define the user experience.

### Self-hosting should preserve control

People should control their media, accounts, and activity. Nama should remain practical to operate at home and should not require unnecessary hosted services.

### Providers should be replaceable

Jellyfin, Plex, Sonarr, Radarr, and metadata services are useful starting points, not permanent foundations. Nama should be able to gain native capabilities over time without a product reset.

### Playback quality comes first

Finding media is only valuable if watching it is reliable and feels native to the device. Playback quality, responsiveness, and platform conventions take priority over feature count.

### User state belongs to the product

Progress, watch history, preferences, requests, and other personal activity should follow the person across providers. Users should not lose the continuity of their experience when an integration changes.

### Complexity must earn its place

Nama should solve current user problems before speculative ones. New infrastructure, abstractions, and features need a concrete use case; plausible future value is not enough.

## Essential experience

The first useful loop is intentionally small:

> Connect a media source → find something → watch it → resume later.

The next meaningful expansion is:

> Find unavailable media → request it → watch it when it becomes available.

Everything else should support these loops or wait until there is evidence that it matters.

## Long-term direction

Nama may eventually provide its own library scanning, metadata, playback, transcoding, and media-management capabilities. Those capabilities should coexist with external services through the same product boundaries.

The visible experience should remain stable as the implementation evolves: one title rather than provider duplicates, one identity rather than separate service accounts, and one set of familiar actions across devices.

## Decision test

When considering a product change, ask:

> Does this make self-hosted media simpler, more coherent, or more dependable without tying Nama to one provider?

If not, it probably does not belong yet.
