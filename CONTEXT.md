# Nama

Nama gives people one coherent way to find, watch, and manage media they control across providers while preserving a consistent product and activity history.

## Language

**Provider**:
A service or capability source that supplies media-related behavior to Nama without defining Nama's user-facing product model.
_Avoid_: Backend

**Provider type**:
An installed kind of provider capability that can be configured as one or more provider instances.
_Avoid_: Integration type, Jellyfin endpoint

**Provider instance**:
One configured connection to a provider type, permanently bound to one provider principal and owning its sources and synchronization evidence.
_Avoid_: Server connection

**Integration**:
The installed relationship represented by a provider instance.

**Provider principal**:
The remote provider identity permanently associated with a provider instance.
_Avoid_: Provider user, account

**Canonical item**:
Nama's provider-neutral identity for one movie, show, season, or episode; matching provider observations may contribute sources to it.
_Avoid_: Provider item, title

**Library entry**:
A canonical item's inclusion in Nama's installation-wide catalog; it is not a per-person grant or temporary provider-availability status.
_Avoid_: Library membership, user grant

**Source**:
One playable edition or encode of a canonical item supplied through a provider instance. Alternate encodes or resolutions of one edition are sources, while distinct cuts are separate canonical items.
_Avoid_: Provider item

**Part**:
One ordered media unit within a source, with its container, size, duration, bit rate, and tracks.
_Avoid_: File

**Track**:
One normalized video, audio, or subtitle stream belonging to a part. Playback uses separate plan- or session-scoped track identities.
_Avoid_: Provider stream, stream index

**Artwork reference**:
A safe Nama-owned reference to artwork that can be resolved into a short-lived locator without exposing a provider path or credential.
_Avoid_: Artwork URL, provider image path

**Locator**:
A short-lived descriptor for provider-hosted artwork or media with narrowly scoped access and redirect rules.
_Avoid_: URL, playback URL, direct URL

**Playback plan**:
An expiring, side-effect-free selection of a source, delivery strategy, and selectable tracks before provider resources are opened.
_Avoid_: Playback session, stream

**Playback session**:
The active Nama-owned playback identity created when a playback plan is opened, with its locator, selected tracks, telemetry order, and cleanup lifecycle.
_Avoid_: Provider session, playback plan

**Watch state**:
Nama's record of whether a playable item is watched and, when present, its resumable position and duration.
_Avoid_: Playback state, progress

**Provider observation**:
Incoming evidence from a provider instance before Nama records its normalized form.

**Provider replica**:
Nama's stored normalized observation of watch state from one provider instance, used as reconciliation evidence rather than canonical truth.
_Avoid_: Provider state, source state

**Operation ID**:
A client-created opaque identifier for one logical mutation across transport attempts.
_Avoid_: Client ID

**Event ID**:
A client-created opaque identifier for one logical telemetry event across transport attempts.
_Avoid_: Operation ID

**Nama endpoint**:
A canonical HTTP(S) base address through which an application reaches Nama. It is a transport address, not a deployment identity.
_Avoid_: Server connection, server identity

**Administrator**:
The sole MVP person authorized to set up, configure, diagnose, and manage Nama.
_Avoid_: Admin user, owner

**Authorizing user**:
The authenticated person whose current Nama session approves an OAuth device authorization for their own access; approval cannot select another person or grant Administrator authority.
_Avoid_: Approving Administrator, target user

**Apple public client**:
The fixed first-party native OAuth client shared by universal Apple app installations and limited to one exact Nama API resource and the consumer scopes.
_Avoid_: Device, paired client

**Consumer scope**:
One of `nama:library`, `nama:playback`, or `nama:user-state`, each authorizing only its owning protected-resource method group.
_Avoid_: Device permission

**Endpoint-bound token bundle**:
One Apple app installation's Keychain record containing its exact Nama endpoint and OAuth access and refresh token material.
_Avoid_: Pairing, Device credential, paired session

**Broad client revocation**:
An Administrator's withdrawal of every refresh-token family for the Apple public client rather than one app installation.
_Avoid_: Device revocation, consent deletion
