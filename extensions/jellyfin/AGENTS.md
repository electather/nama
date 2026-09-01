# Jellyfin server extension guidance

This subtree owns the manually installed .NET 9 extension for the exact accepted
Jellyfin 10.11.11 host. Preserve these invariants for every extension change:

- Validate the exact host and advertise extension-backed capabilities only when
  compatibility is proven; stock provider capabilities remain available when it
  is absent, unhealthy, or incompatible.
- Authenticate every private `/Nama/v1` control endpoint with a real Jellyfin API
  key. Keep that reusable key inside the protected media lease and rewritten
  internal request.
- Keep plan, session-context, media-lease, and media-resource protection
  purpose-separated. The persisted extension-owned Data Protection key ring is
  secret backup material and must remain outside Jellyfin's host-wide provider.
- Keep every Nama-exposed media, playlist child, key, redirect, and subtitle in
  the opaque extension namespace under the exact session lease. Stock paths,
  provider IDs, API keys, and broad authorization never cross that boundary.
- Bound live state to 128 unexpired plans, 16 retained sessions, and the specified
  duration-derived accepted-event capacity. Retain closed sessions and every
  accepted identity until expiry; replay matching Open and Event identities
  before capacity rejection and never evict identities to admit new work.
- Reject new plan, session, or Event work before Jellyfin side effects with its
  exact HTTP 429 reason. Remove expired indexes under the session gate without
  disposing coordination that a concurrent Report or Close can reference.
- Propagate cancellation while Open, Report, or Close waits on extension gates,
  and recheck expiry after admission. Once an uncancellable Jellyfin mutation
  begins, complete its local replay, sequence, and terminal bookkeeping.

`mise run check:jellyfin-extension` is the native owner: locked restore,
formatting, MSTest/Microsoft Testing Platform execution, analyzer-clean Release
compilation, exact artifact packaging, and the fault-injected fixture all pass
there. Retain the compiled TypeScript/Jellyfin process suite as the real-host
installation and private-protocol proof.
