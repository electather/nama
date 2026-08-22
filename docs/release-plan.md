# Nama Release Plan

## Purpose

This roadmap turns Nama's architecture into the smallest sequence of releasable vertical slices. The first product is a private, single-user universal SwiftUI app for iOS, tvOS, and macOS connected to an existing Jellyfin server. Version 1 is a stable multi-user media aggregation and playback platform. Every milestone must exercise real contracts end to end; speculative marketplaces, runtimes, media processing, and social features wait for demonstrated demand.

## Fixed constraints

- The core is TypeScript on Node.js 24 using pnpm, ESM, an exact-pinned Effect v4 beta, Drizzle ORM with PostgreSQL, Protobuf, ConnectRPC, and Buf.
- `api.v1` is the public client contract. `plugin.v1` is the separate provider contract. Generated SDKs, not handwritten parallel clients, consume both contracts.
- Better Auth is private to the core behind Nama-owned setup and authentication RPCs. Neither the Go CLI nor the universal Apple app imports Better Auth types.
- The Go `nama` CLI is the MVP management interface. It supports complete help, generated shell completion, stable exit codes, non-interactive flags, JSON output, and a repository Codex `SKILL.md`.
- The production server target is Linux in Docker. Deployment is one Nama image containing the core and bundled plugin executables, plus PostgreSQL. macOS is both a server development target and a supported client platform.
- Provider plugins are stateless, supervised subprocesses. They use ConnectRPC over Unix domain sockets and never access the database. The core owns configuration, secrets, cursors, retries, reconciliation, and all durable state.
- Jellyfin is the first provider. Media bytes normally travel from Jellyfin directly to the Apple client; Nama remains the control plane.
- The first client is one universal Swift/SwiftUI app rooted in `apps/ios`, targeting iOS 26+, tvOS 26+, and macOS 26+. One exact-pinned, security-reviewed playback engine is contained by a thin Nama-owned adapter with no engine types outside it.
- Nama is not an ingress product. LAN/VPN and user-managed reverse proxies are supported; certificate issuance, tunnels, and port forwarding are not.
- The core is canonical for user state. Synchronization is two-way, newest reliable activity wins, configured provider priority breaks ties or substitutes for missing timestamps, and a Nama-originated action wins before being propagated outward.

## Release gates and dependency order

```text
contracts + repository baseline
  -> risk spikes
  -> core bootstrap/auth + CLI
  -> plugin runtime + Jellyfin configuration
  -> browse/details/playback vertical slice
  -> durable progress + two-way sync
  -> private single-user MVP
  -> operational hardening
  -> second provider + canonical identity proof
  -> multi-user authorization
  -> v1 release
```

A later milestone may not hide a failed earlier gate. In particular, UI breadth must not compensate for unreliable playback, plugin IPC, identity mapping, or synchronization.

## Milestone 0: Contracts and workspace baseline

### Goal

Create the smallest buildable monorepo skeleton and establish the two contracts before application behavior grows around provider-specific shapes.

### Included

- pnpm workspace for the TypeScript core, generated TypeScript code, and JavaScript tooling.
- Independent native tooling for Go, Protobuf/Buf, and Docker, plus committed generated Swift bindings for the future client; no application target is created only to make the boundary appear complete.
- `api.v1` services: `HealthService`, `SetupService`, `AuthService`, `DeviceService`, `ProviderService`, `LibraryService`, `PlaybackService`, `UserStateService`, and `SyncService`.
- `plugin.v1` services: `HealthService`, `PluginService`, `LibraryService`, `PlaybackService`, and `WatchStateService`.
- Provider-independent identifiers and minimal movie/show/season/episode, source, artwork, track, playback descriptor, and user-state messages.
- Buf linting, deterministic generation, and breaking-change checks in CI.
- A single development command for contract generation and repository checks.

### Explicit non-goals

- A generic plugin SDK, marketplace manifest, permission language, WASM host, REST API, GraphQL, event bus, or generated clients for platforms not being built.
- Exhaustive media metadata. Add fields only when the Jellyfin-to-Apple-app slice consumes them.

### Exit criteria

- TypeScript and Go consumers compile from the same committed schemas; Swift bindings are generated deterministically, and the future iOS application restores their native compilation check across iOS, tvOS, and macOS.
- Buf rejects a deliberate breaking `v1` contract change.
- Of provider identifiers, public messages may expose only Nama-managed provider type and instance IDs; remote provider resource references exist only in `plugin.v1`.

## Milestone 1: Retire the highest risks with disposable spikes

### Goal

Prove the choices most likely to invalidate the design before building product layers on them. Spike code is disposable after its durable decisions and evidence are recorded.

### Included

1. **Apple TV playback feasibility — passed and retired:** exercise representative H.264, HEVC, MKV, HDR10, Dolby Vision, multichannel audio, text subtitles, and image subtitles; inspect seeking, track switching, failure signals, adapter isolation, locator security, and distribution obligations. The feasibility pass records architecture knowledge, not physical-device or production-engine acceptance.
2. **Jellyfin negotiation:** submit actual device capabilities, obtain direct-play/direct-stream/transcode choices, and confirm that media URLs can be consumed directly by the universal Apple app without routing bytes through Nama. Verify that unsupported audio/subtitles can be converted without forcing video transcoding when Jellyfin permits it.
3. **Plugin IPC:** launch a disposable subprocess, create a socket inside a core-owned `0700` runtime directory, authenticate with a per-launch secret, call health and one provider operation, enforce a deadline, then terminate and restart cleanly.
4. **Connect-wrapped Better Auth:** create an administrator, sign in, authenticate a protected RPC with the returned session credential, retrieve the current user, and sign out without exposing Better Auth types or endpoints to clients.
5. **Sync semantics:** replay timestamped and untimestamped provider events through the reconciliation rules and prove idempotency, backward progress for a genuine rewatch, tie-breaking, and prevention of echo loops.

### Explicit non-goals

- Production UI, broad codec promises, performance tuning, automatic engine fallback, or a second player implementation.

### Exit criteria

- All five spikes resolve their named risk with recorded evidence. The retired playback spike does not replace the physical-device, security, and distribution matrix required before product playback ships.
- Any unsupported sample needs a documented Jellyfin direct-stream/transcode fallback. If Dolby Vision or HDR metadata is not preserved acceptably on physical hardware, the player choice returns to design review.

## Milestone 2: Bootable core, administrator setup, and CLI

### Goal

Make a fresh deployment securely configurable without a web application.

### Included

- Effect-based Node.js core with liveness/readiness endpoints, structured logs, TOML configuration plus five explicit environment overrides, graceful shutdown, and automatically applied Drizzle-managed PostgreSQL migrations.
- Minimal persistence for reviewed Better Auth tables and a permanent server-initialization marker; plugin, pairing, media, and sync schemas are added only by the milestones that exercise them.
- On an unconfigured server, generate a high-entropy, single-use bootstrap token and print it to the operator console. It remains valid until used or process restart; restart replaces it. Creating the first administrator permanently disables setup mode.
- App-owned Connect setup/auth RPCs backed by Better Auth: create administrator, sign in, current user, and sign out.
- `nama` CLI commands to target a server, complete first setup, sign in, inspect status, and render human-readable or JSON output.
- CLI help, version reporting, generated shell completions, non-interactive operation, stable documented exit codes, and redaction of tokens/passwords.
- A repository Codex skill describing command discovery, JSON use, safe setup/configuration flows, and confirmation rules for future destructive commands.

### Explicit non-goals

- Public signup, invitations, password-reset email, OAuth/OIDC, roles beyond the sole administrator, a web admin UI, or storing the bootstrap token in the database.

### Exit criteria

- From empty PostgreSQL, an operator can start Nama, create exactly one administrator with the emitted token via CLI, and sign in afterward.
- Reuse of the token, setup after initialization, unauthenticated protected RPCs, secrets in logs other than the one documented bootstrap-console emission, and public API calls over an expired Better Auth session all fail safely.
- The complete setup flow is runnable non-interactively and returns parseable JSON.

## Milestone 3: Plugin runtime and Jellyfin connection

### Goal

Prove that Jellyfin is an implementation of capabilities, not part of the core.

### Included

- Core supervision of bundled plugin executables: validated launch, per-launch authentication, Unix-socket lifecycle, deadlines, bounded restart behavior, stderr log capture, and cleanup on shutdown.
- Start plugins on demand and stop them when idle. No plugin memory is treated as durable.
- Core-owned Jellyfin instance configuration and credentials, managed through CLI. Persistence for plugin installations, instances, and encrypted provider credentials begins in this milestone; the plugin receives only the configuration needed for an operation.
- Jellyfin plugin implementations of minimal library reads, public artwork resolution, watch-state reads, and watched/unwatched writes.
- Connection test and capability inspection commands.
- One application image that includes the core and bundled Jellyfin executable; PostgreSQL remains the only separate service.

Playback planning, scoped opening and reporting, and coherent exact progress
export remain MVP release blockers outside this milestone. The Jellyfin
provider type advertises none of those capabilities until its adapter satisfies
the existing contracts without exposing a reusable provider credential,
relaying media through Nama, or splitting one coherent state target across
provider writes.

### Explicit non-goals

- Plugin download/install/update UX, third-party distribution, background plugins, plugin databases, container-per-plugin deployment, Windows named pipes, or exposing plugin ports.

### Exit criteria

- A fresh container deployment can configure and validate one Jellyfin instance using only `nama` CLI commands.
- Killing the plugin cannot crash the core or corrupt state; a later operation starts a clean process and succeeds within the retry policy.
- Socket files are inaccessible outside the intended runtime user/directory, and the plugin has no PostgreSQL credentials.

## Milestone 4: iOS app pairing, browsing, and direct playback

### Goal

Deliver the primary loop on iPhone, iPad, Apple TV, and Mac: discover or connect to Nama, pair, browse Jellyfin, open details, and watch media.

### Included

- LAN discovery using mDNS/DNS-SD service `_nama._tcp`, plus manual server URL entry for LAN, VPN, and reverse-proxy deployments on every supported Apple platform.
- Plain HTTP only for loopback, private/link-local addresses, or `.local` discovery names, with a clear warning. Public hostnames and addresses require HTTPS.
- Netflix-style device flow: the app requests and displays a short-lived code; an authenticated administrator approves it with `nama devices approve`; the app receives a revocable device session. Codes are rate-limited, single-use, and contain no reusable secret.
- Persistence for pairing requests, device credentials, minimal canonical media, library membership, and provider-to-canonical mappings begins in this milestone.
- Provider-neutral Home/library browsing for movies and shows, basic search of available media, media details, artwork, seasons, and episodes.
- A thin `NamaPlayer` adapter around one exact-pinned, security-reviewed engine. Shared UI and networking code consumes only Nama-owned playback and state types; platform-specific presentation or system adapters exist only where the supported Apple platforms differ.
- The app reports the current device's real playback capabilities. Selection order is direct play, direct stream/remux, selective stream conversion, then full transcode. User-selected quality may request transcoding explicitly.
- Playback from provider-issued URLs, play/pause, seek, audio/subtitle selection, visible loading/failure states, and recovery to the details screen.
- Accessibility and input basics for each platform: focus order, readable labels, Dynamic Type where supported, contrast, keyboard, pointer, touch, and remote interaction, with no critical action available only through an undiscoverable gesture.

### Explicit non-goals

- Android, web UI, separate Apple-platform codebases, offline downloads, live TV, AirPlay-specific features, custom video rendering, a second playback engine, or Nama media proxying.

### Exit criteria

- On a fresh iPhone or iPad, Apple TV, and Mac, the user can discover a LAN server or enter its URL, approve the device in the CLI, browse, search, open a movie or episode, and begin playback.
- Supported fixtures direct-play through the selected engine on each platform; incompatible fixtures follow the expected Jellyfin fallback without sending media bytes through the core.
- Device revocation immediately prevents new authenticated RPCs.

## Milestone 5: Canonical progress and continuous two-way Jellyfin sync

### Goal

Make Nama, rather than Jellyfin, own reliable resume and watched state while remaining synchronized with provider activity.

### Included

- Durable playback position, duration, watched status, activity timestamp, source, and reconciliation metadata in Nama.
- Periodic progress checkpoints during playback plus final updates on pause, stop, completion, and app backgrounding. Writes are idempotent and tolerate retries/out-of-order delivery.
- Continue Watching, resume playback, and watched/unwatched controls sourced from Nama.
- Core-scheduled Jellyfin pull and push operations. Core stores cursors/checkpoints, backoff, pending work, and reconciliation decisions; the plugin only translates provider operations.
- Latest reliable user activity wins, including legitimate rewind/rewatch movement. Configured provider priority handles missing timestamps and exact ties. A local Nama action wins immediately and is exported.
- Origin/version tracking prevents a provider echo from becoming a new activity. Failed exports retry safely and surface operator-visible sync health through CLI.
- Initial full import followed by incremental or bounded polling. Poll frequency and concurrency are conservative configuration values, not an elaborate scheduler.

### Explicit non-goals

- Favourites, playlists, recommendation signals, mapping multiple Nama users to provider users, real-time webhook infrastructure, or conflict-resolution UI. The immutable single provider principal configured for an MVP instance is not deferred.

### Exit criteria

- Playback in Nama updates Continue Watching and Jellyfin; playback changed directly in Jellyfin appears in Nama within the documented polling interval.
- Restarting the core or plugin during import/export neither loses the last acknowledged state nor creates an infinite sync loop.
- Automated reconciliation fixtures cover newer/older timestamps, missing timestamps, ties, rewatches, duplicates, retry, and echo suppression.

## MVP release: private single-user iOS app

### Release contents

Milestones 0-5 form the MVP. It supports one administrator, one or more configured Jellyfin instances, universal iOS app pairing across iOS, tvOS, and macOS, provider-neutral browse/search/details, broad direct playback with controlled fallback, and canonical two-way progress/watch-state synchronization.

### Release acceptance

- A documented Docker Compose deployment brings up the Nama image and PostgreSQL with persistent volumes, health checks, and no privileged container requirement.
- The complete empty-install-to-playback journey works using the CLI and the iOS app on iPhone or iPad, Apple TV, and Mac without editing the database or calling provider APIs manually.
- Backup and restore of Nama's database/configuration is documented and exercised once; provider media is outside Nama's backup scope.
- Authentication, setup, pairing, URL validation, secret handling, plugin IPC, and authorization have focused negative-path tests.
- Public and plugin schemas pass lint/breaking checks; core and CLI checks pass; iOS, tvOS, and macOS app builds pass; and the representative physical-device playback matrix passes.
- Fresh-install, upgrade-from-previous-migration, restart-during-sync, provider-unavailable, and database-unavailable scenarios fail visibly and recover without data corruption.

### MVP non-goals

- Multiple users, invitations/RBAC, Plex, Sonarr/Radarr, discovery of unavailable media, web/Android clients, separate Apple-platform clients, downloads, deletion, playlists, favourites, comments, recommendations, notifications, plugin marketplace/WASM, native media serving, scanning, or transcoding.

## Milestone 6: Operational hardening after MVP

### Goal

Turn the proven vertical slice into software that can be upgraded and operated safely before expanding features.

### Included

- Versioned releases, migration compatibility policy, rollback instructions where schema changes permit it, image provenance, dependency/license inventory, and security update process.
- Bounded resource use for plugin processes and sync work, actionable health/status output, log redaction, and stable CLI diagnostics.
- Test fixtures for supported Jellyfin versions and the playback matrix gathered during real MVP use.
- Performance budgets based on observed libraries for startup, common API latency, sync duration, and idle resource use. Optimize only exceeded budgets.

### Explicit non-goals

- Kubernetes manifests, distributed tracing, high availability, horizontal scaling, or a custom observability stack.

### Exit criteria

- At least one full upgrade and restore rehearsal succeeds on a copy of realistic data.
- A missing provider, crashed plugin, malformed provider response, and interrupted migration have documented operator outcomes.

## Milestone 7: Second provider and canonical identity proof

### Goal

Prove multi-provider aggregation and multi-input synchronization before declaring the plugin and canonical-media boundaries stable.

### Included

- Plex as the second library/playback/watch-state plugin, using the unchanged subprocess model.
- Multiple configured plugin instances and administrator-defined watch-state priority.
- Canonical matching based first on reliable external IDs, then conservative title/year/type evidence. Ambiguous items remain separate; automatic fuzzy merging is not allowed.
- One canonical item may expose several playback sources. The user can choose a source; a simple deterministic default may prefer the last successful or administrator-prioritized source.
- Two-way synchronization across configured watch-state providers through the same core reconciliation path.
- Contract changes driven by the second real implementation, followed by freezing stable `plugin.v1` semantics.

### Explicit non-goals

- A generic plugin marketplace/SDK, aggressive fuzzy deduplication, automatic cross-provider credential mapping, source quality scoring, or provider-specific UI in clients.

### Exit criteria

- The same title from Jellyfin and Plex appears once when reliable identity evidence matches and exposes both sources.
- Conflicting progress from two configured providers resolves deterministically, propagates outward without loops, and remains stable after restart.
- Adding Plex requires no Plex branch in the iOS app or public API.

## Milestone 8: Multi-user product model

### Goal

Advance from a private appliance to the multi-user platform described by the product philosophy without weakening core ownership or provider isolation.

### Included

- Invitation-only account creation; public registration remains disabled.
- Minimal Admin, Member, and Viewer roles with explicit core-enforced permissions.
- Per-user library/resource grants and only the stream/request limits required by current features.
- Independent per-user history, progress, watched state, pairing, and device/session revocation.
- Explicit administrator mapping when a provider identity is needed for per-user synchronization; no inferred identity linking.
- CLI management for users, invitations, grants, roles, sessions, devices, and mappings, with JSON parity and confirmations for destructive actions.

### Explicit non-goals

- A policy language, arbitrary custom roles, groups, enterprise SSO, public signup, SMTP dependency, impersonation, or plugin-owned authorization.

### Exit criteria

- Two users can watch the same canonical item with independent state and restricted library visibility.
- Every public RPC has an authorization test covering allowed and denied access; plugins receive only already-authorized operations.
- Removing a grant or account revokes access without deleting another user's state.

## Milestone 9: v1 release candidate

### Goal

Ship a coherent, supportable v1 centered on aggregation and excellent native playback rather than accumulating unrelated features.

### Required scope

- Everything accepted in Milestones 0-8.
- Stable documented `api.v1` and `plugin.v1` compatibility rules and upgrade path.
- Jellyfin and Plex library/playback/watch-state integrations.
- Multi-user invitation, authorization, device, and state isolation.
- Universal iOS app browse/search/details/playback/Continue Watching across iOS, tvOS, and macOS with direct-play-first negotiation and the verified HDR/Dolby playback matrix.
- Docker deployment, PostgreSQL backup/restore, upgrade documentation, CLI administration, and agent skill.
- Security review of all trust boundaries and an end-to-end release test from fresh install through two-provider playback and synchronization.

### Conditional additions

The following enter v1 only if MVP users demonstrate a concrete need and the feature can be delivered without delaying the required scope:

- TMDB metadata/discovery to repair materially poor provider metadata or enable a clearly requested discovery flow.
- Favourites implemented as the smallest core-owned collection primitive, only if users need durable curation before playlists exist.
- Recently Added or a richer Home screen assembled from existing library queries, only if navigation evidence shows the basic library is insufficient.

Conditional work must pass the same architecture boundaries and may be cut without delaying v1.

### Explicit v1 non-goals

- Sonarr/Radarr acquisition, request workflows, offline downloads, deletion/media management, Android/web applications, separate Apple-platform clients, playlists, comments, notifications, recommendation ML, plugin marketplace, WASM runtime, native media scanning/serving/transcoding, live TV, high availability, or cloud-hosted control services.

### v1 exit criteria

- All required user journeys pass against supported Jellyfin and Plex versions on a clean install and an upgraded install.
- No known issue can expose credentials, cross user/resource boundaries, corrupt canonical state, loop synchronization indefinitely, or misrepresent HDR/Dolby playback support.
- Release artifacts are reproducible, versioned, documented, and usable without unreleased tools or manual database changes.
- The v1 schema compatibility test proves that supported clients and plugins receive explicit errors for unsupported versions rather than undefined behavior.

## Post-v1 candidates, in evidence order

After v1, add one product loop at a time:

1. **Discovery and acquisition:** TMDB discovery followed by stateless Radarr and Sonarr plugins, core-owned request records/approval/status, and the loop “find anything -> request it -> watch it.”
2. **Additional native clients:** Android or another non-Apple platform only when target-user demand justifies maintaining another native UI; share contracts, not UI code.
3. **Personal collections:** favourites, then playlists, using one proven core primitive rather than parallel models.
4. **Offline and media management:** only after permissions, failure semantics, provider-specific deletion, and recovery behavior are designed and tested.
5. **Plugin distribution/runtime:** a third-party SDK, manifests, permissions, marketplace, and WASM only when an external plugin author or unsafe distribution problem actually exists.
6. **Native media provider:** scanning, filesystem watching, streaming, remux/transcode, and persistence as a privileged/background first-party plugin when replacing existing servers becomes a funded product goal.

Comments, social features, and recommendation ML remain outside the roadmap until a demonstrated use case exists. If recommendations become valuable, begin with transparent metadata-based scoring before considering ML.

## Major risks and containment

| Risk | Earliest proof | Containment |
| --- | --- | --- |
| On-device playback-engine maturity, security, licensing, or HDR/Dolby regressions | Milestone 1 source review and Milestone 4 physical-device matrix | Pin and inspect an exact revision, isolate it behind `NamaPlayer`, reproduce the representative media and network matrix on iOS, tvOS, and macOS, meet linked-artifact distribution obligations, and stop feature work if locator safety, native output, or distribution viability is not trustworthy. |
| Jellyfin capability negotiation forces avoidable transcodes | Milestone 1 provider spike | Send measured client capabilities, distinguish container/audio/subtitle incompatibility from video incompatibility, and inspect the selected delivery mode in tests. |
| Plugin subprocess/UDS behavior becomes platform or lifecycle complexity | Milestones 1 and 3 | Support Linux production/macOS development only, keep plugins stateless/on-demand, use one authenticated socket per process, and defer other transports. |
| Better Auth does not map cleanly behind Connect | Milestone 1 auth spike | Keep app-owned auth messages/session semantics and allow replacement without changing generated client contracts. |
| Provider timestamps are missing or semantically different | Milestones 1 and 5 | Preserve source evidence, use explicit provider priority, make updates idempotent, and expose sync health instead of silently guessing. |
| Canonical matching merges different titles | Milestone 7 | Prefer reliable external IDs, leave ambiguity unmerged, and avoid fuzzy automation until measured false-positive/negative data exists. |
| Direct provider URLs expose credentials or are unreachable from an Apple client | Milestones 1 and 4 | Return short-lived/minimal playback descriptors where supported, never log URLs/tokens, validate reachability from iOS, tvOS, and macOS, and fail explicitly rather than proxying by default. |
| Single image obscures plugin isolation | Milestone 3 | Preserve the process and contract boundary inside the image; packaging together never permits imports, shared memory state, or database access. |
| Scope expands before the playback loop works | Every release gate | A milestone exits only on its acceptance criteria; conditional and post-v1 features cannot block the required vertical slice. |

## Definition of done for every milestone

- The smallest end-to-end behavior is demonstrated through generated contracts.
- Trust-boundary validation, safe error handling, and one runnable regression check accompany every non-trivial rule.
- Logs and CLI output explain operator-actionable failures without exposing secrets.
- Documentation states supported behavior and explicit exclusions; it makes no codec/provider compatibility claim that was not exercised.
- New abstractions or dependencies solve a present requirement in that milestone. Otherwise they are removed or deferred.
