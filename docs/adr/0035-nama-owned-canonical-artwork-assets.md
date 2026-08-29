# Persist canonical artwork assets in Nama

Status: accepted

Nama persists bounded provider artwork renditions during canonical catalog ingestion and serves them through signed, short-lived Nama-owned locators. Public `ResolveArtwork` never exposes or contacts a provider; provider item IDs, artwork references, paths, cache tags, and credentials remain below the import seam. Artwork acquisition is best effort per asset so unavailable or unsafe bytes retain the existing title fallback without failing the canonical media import. Reconciliation replaces stored bytes when the provider artwork reference changes and retires assets with their canonical artwork identity.

Playable media remains provider-direct under ADR-0013. Artwork is the deliberate exception because it is bounded catalog metadata whose stable, provider-neutral presentation is worth Nama's storage and egress cost. Rejected alternatives were reversible provider identifiers in direct locators, a non-persistent relay, and disabling provider artwork.
