# Nama System Architecture

This document is Nama's canonical architecture entry point and ADR index. Read [philosophy.md](philosophy.md) for product intent and then use each source according to its role:

| Need                                        | Authoritative source                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| Domain language                             | [CONTEXT.md](../CONTEXT.md)                                                     |
| Accepted architectural choice and rationale | [ADRs](adr/)                                                                    |
| Current and target system shape             | This document and the linked [subsystem notes](#subsystem-architecture)         |
| Required behavior                           | The relevant contract, including [API contracts](architecture/api-contracts.md) |
| Concrete wire definitions                   | [Protobuf](../proto/)                                                           |

## System shape

Nama's target MVP is a self-hosted control plane, not a media relay. A TypeScript core owns identity, configuration, the canonical media model, watch state, reconciliation, and authorization. Provider plugins translate between that model and external services. Application APIs use the versioned Protobuf/ConnectRPC contract; Better Auth's standard OAuth HTTP endpoints authorize the Apple public client. During playback the provider sends media directly to the client; the core only selects and authorizes the source.

```text
Apple app ── OAuth device grant ──┐
Go CLI ───── Connect approval ────┤
Apple app ──────────────┐         ├──> Node core ───> Drizzle ORM ───> PostgreSQL
Go CLI ── Connect api.v1├─────────┘        │
                        │                  └── Connect plugin.v1 over Unix socket
                        │                                   │
                        │                            Jellyfin plugin ───> Jellyfin API
                        │                                   │
Apple player <──────────┴────────────────── playable URL ──┘
```

The target installation is one private deployment with one administrator, Jellyfin as its first provider type, and one universal SwiftUI client for iPhone, iPad, Apple TV, and Mac on Apple platform version 26 or later. Multiple Jellyfin provider instances may supply watch-state input. The public and plugin contracts are real from the first vertical slice, while a marketplace, web console, generic workflow engine, distributed queue, and native media server are not part of the target architecture.

The MVP authorization path is complete without a browser: an already authenticated Go CLI sends the Apple app's displayed user code through role-neutral `AuthService.ApproveDeviceAuthorization`, and the core binds the grant to that session principal before invoking Better Auth's internal verification and approval APIs. The request selects no target user and grants no Administrator authority. Issue #167 may add a narrow browser approval web app over the same internal application service; it does not become a prerequisite for Apple authorization or a general web console.

The implemented baseline runs one Effect application with one native listener, immutable configuration, reviewed Drizzle migrations, fail-closed initialization reconciliation over one PostgreSQL pool, setup and authentication RPCs, the durable provider persistence/protection boundary, and the authenticated plugin supervisor. Provider discovery, connection testing, provider-instance lifecycle management, initial canonical catalog ingestion, and stored public Library reads are executable; playback remains unimplemented.

The same listener now exposes the fixed Apple public client's allowlisted Better Auth metadata, JWKS, device-code, token, refresh, and revocation routes. Generated `AuthService` handlers approve the current session principal's grant and revoke the fixed client's refresh-token families; Connect consumer authority verifies audience-bound, fixed-client, method-scoped JWTs locally without treating them as Administrator sessions.

The plugin supervisor validates scoped code-owned handles without launching a process. A single canonical stdin document selects context-free discovery, one-shot candidate verification, or exact provider-instance revision operation while keeping provider context out of arguments, inherited environment, RPC traffic, and logs. Candidate completion retires its child. Same-revision instance handles share one lifecycle; replacement fences stale admission, drains admitted work, and completes process cleanup before the next revision can launch. Each valid call holds demand through lifecycle waiting and RPC completion; zero demand starts a fixed 30-second grace, successful expiry removes the process group and launch artifacts, and later demand creates a fresh authenticated incarnation. Failed idle cleanup disables only that handle, retains cleanup ownership without a background retry loop, and remains retryable by scope finalization; persistent failure stays on the existing shutdown-failure path.

Provider management authenticates stored credential envelopes per instance during
startup, excludes unreadable instances from installation-wide schema
reconciliation, and keeps the provider type available for healthy instances.
The public candidate and stored-instance connection-test RPCs use the same
one-shot or exact-revision supervisor paths as mutations and condition stored
observations on the revision that was tested.
The production Jellyfin adapter serves bounded targeted library observations
for movies, shows, positive-numbered seasons, and positive-numbered episodes,
resumable best-effort full catalog and movie/episode watch-state scans, targeted
movie and episode watch-state reads, explicit watched/unwatched writes, and
observed artwork resolution into proven anonymous public leases for exact
instance launches. It advertises `LIBRARY_READ`, `ARTWORK_RESOLVE`,
`WATCH_STATE_READ`, and `WATCHED_WRITE`.

The provider-management verification gate drives a compiled `nama` binary
through the production listener, migrations, PostgreSQL boundary, supervisor,
Jellyfin plugin, and a pinned disposable Jellyfin server. It proves fresh
creation, exact durable restart recovery, accepted-schema upgrade containment,
wrong-key and damaged-envelope containment beside healthy mutation, connection
testing through candidate and exact stored-revision subprocesses, credential
and configuration cutover, disable/re-enable/delete, retained operation replay,
and safe boundary output. Targeted normalized Jellyfin movie, show, season,
episode, and watch-state observations, resumable catalog and watch-state scans,
explicit watched/unwatched writes, anonymous artwork resolution, user-facing
provider connection tests, and the local Linux application image are
implemented. The Docker gate drives the real image through canonical Compose,
the compiled Go CLI, the pinned Jellyfin fixture, plugin-child recovery,
application replacement, and graceful shutdown. Core initial catalog ingestion
and authenticated stored `LibraryService` reads are implemented and exercised
through real Connect over a supervised production Jellyfin scan.

The current core technology is Node.js 24, strict TypeScript, ESM, pnpm, Effect, native Node HTTP, Drizzle, and PostgreSQL. The CLI currently targets Go and Cobra. These are living technology and repository architecture, not additional ADRs.

The universal SwiftUI application consumes the generated public client for one
connection tracer on iOS, iPadOS, tvOS, and macOS. Its connection surface keeps
manual HTTP(S) endpoint entry available beside explicit `_nama._tcp` LAN
discovery. `NamaEndpoint` admits HTTPS or lexically approved local HTTP without
DNS resolution, so manual entry, discovery, retry, and restoration reject every
other HTTP destination before verification. Before the first request to a
permitted local HTTP endpoint without an exact persisted acknowledgement,
manual entry, discovery, and restoration require explicit confirmation.
Cancelling returns each ingress path to its safe source state; continuing
retains acknowledgement through failures and retries, then persists it only
after successful verification. Every selected local HTTP state carries a text,
symbol, and accessibility warning.

Permitted local HTTP verification uses an endpoint-scoped proxy-free URLSession
configuration, while HTTPS retains the supplied normal configuration and system
proxy behavior. Both schemes refuse redirects, retain platform TLS trust, and
run with the app's narrow ATS local-networking declaration rather than
arbitrary-load or per-domain exceptions.

A foreground-scoped `NWBrowser` reconciles only transport-eligible
advertisements by normalized endpoint and never contacts or selects a candidate
without a person choosing it. The app persists the last successfully verified
canonical endpoint and its exact local-HTTP acknowledgement in `UserDefaults`,
shares them across windows, and reverifies the endpoint once per window after
launch. Missing, partial, stale, or mismatched acknowledgement asks again
rather than authorizing another endpoint. Safe failures retain the endpoint; a
legacy forbidden HTTP value remains visible in a blocked HTTPS-required state
until explicit Change Endpoint. The app implements native Better Auth device
authorization, returned-interval polling, refresh rotation, and a
this-device-only endpoint-bound Keychain token record. The universal target now
contains exact-pinned AetherEngine `6.21.0` behind the complete Nama-owned
player boundary; a controlled SDR HLS fixture loads, renders, and stops through
that adapter in macOS-hosted automation. Apple-platform builds pass, and a
signed Apple TV 4K simulator has completed the no-browser authorization, scoped
consumer verification, Keychain commit, and relaunch restoration flow. Product
media behavior, physical Apple hardware, expiry-driven actual-surface refresh,
and the remaining Apple surfaces remain unverified.

## Architectural decision records

ADRs record the choices and rationale below; superseded records remain linked as history, while living architecture and contracts retain current shape and required behavior.

1. [ADR-0001 — Use one Effect application graph for the core](adr/0001-effect-application-graph.md)
2. [ADR-0002 — Own HTTP lifecycle with one native Node listener](adr/0002-native-node-http-lifecycle.md)
3. [ADR-0003 — Use Protobuf and ConnectRPC as Nama's versioned RPC boundary](adr/0003-protobuf-connectrpc-boundary.md)
4. [ADR-0004 — Keep public and plugin Protobuf packages independent](adr/0004-independent-public-plugin-protobuf-packages.md)
5. [ADR-0005 — Expose one provider-neutral, domain-oriented public API](adr/0005-provider-neutral-public-api.md)
6. [ADR-0006 — Run integrations as stateless supervised subprocesses](adr/0006-stateless-supervised-plugin-subprocesses.md)
7. [ADR-0007 — Keep Better Auth private behind Nama-owned authentication RPCs](adr/0007-private-better-auth-adapter.md)
8. [ADR-0008 — Fail closed on ambiguous setup commits and reconcile on restart](adr/0008-fail-closed-setup-reconciliation.md)
9. [ADR-0009 — Confirm durable revocation before reporting sign-out success](adr/0009-confirm-durable-session-revocation.md)
10. [ADR-0010 — Use one PostgreSQL and Drizzle persistence boundary](adr/0010-postgresql-drizzle-persistence-boundary.md)
11. [ADR-0011 — Build one universal native Apple application](adr/0011-universal-native-apple-application.md)
12. [ADR-0012 — Contain the playback engine behind one concrete Nama adapter](adr/0012-single-playback-engine-adapter.md)
13. [ADR-0013 — Deliver media directly with origin-scoped short-lived locators](adr/0013-origin-scoped-short-lived-locators.md)
14. [ADR-0014 — Model playback as plan, open, report, and close](adr/0014-four-stage-playback-lifecycle.md)
15. [ADR-0015 — Make the CLI a thin public-API client](adr/0015-thin-management-cli.md)
16. [ADR-0016 — Package one Linux application image with a separate PostgreSQL service](adr/0016-linux-application-image-and-postgresql.md)
17. [ADR-0017 — Use Mise only as a thin orchestrator over native owners](adr/0017-mise-thin-native-orchestrator.md)
18. [ADR-0018 — Commit generated bindings only for present consumers](adr/0018-commit-present-consumer-bindings.md)
19. [ADR-0019 — Configure providers through one restricted schema-driven surface](adr/0019-restricted-schema-driven-provider-configuration.md)
20. [ADR-0020 — Make provider-secret classification monotonic](adr/0020-monotonic-provider-secret-classification.md)
21. [ADR-0021 — Bind each provider instance to one immutable provider principal](adr/0021-immutable-provider-principal-binding.md)
22. [ADR-0022 — Store a canonical provider-neutral item/source model](adr/0022-canonical-provider-neutral-media-model.md)
23. [ADR-0023 — Make Nama canonical for watch state with explicit reconciliation precedence](adr/0023-canonical-watch-state-reconciliation.md)
24. [ADR-0024 — Use best-effort provider scans and core-owned checkpoints](adr/0024-best-effort-provider-scans.md)
25. [ADR-0025 — Authorize generated RPC methods through a default-deny inventory](adr/0025-default-deny-rpc-authorization.md)
26. [ADR-0026 — Normalize failures with Connect codes and standard Google RPC details](adr/0026-standard-google-rpc-error-details.md)
27. [ADR-0027 — Separate request correlation from durable logical-operation idempotency](adr/0027-logical-operation-idempotency.md)
28. [ADR-0028 — Domain-separate provider credential and principal protection](adr/0028-domain-separated-provider-protection.md)
29. [ADR-0029 — Require Apple platform version 26](adr/0029-apple-platform-26-minimum.md)
30. [ADR-0030 — Keep one active pairing per Apple app installation (superseded by ADR-0033)](adr/0030-one-active-apple-pairing.md)
31. [ADR-0031 — Separate Device credential verification from Pairing delivery (superseded by ADR-0033)](adr/0031-separate-device-verification-from-pairing-delivery.md)
32. [ADR-0032 — Use AetherEngine 6.21.0 with a bounded MVP security exception](adr/0032-aetherengine-mvp-security-exception.md)
33. [ADR-0033 — Use Better Auth OAuth device authorization](adr/0033-better-auth-oauth-device-authorization.md)

## Invariants

1. The core is the source of truth for Nama-owned user and watch state; plugins never become hidden databases. See [ADR-0006](adr/0006-stateless-supervised-plugin-subprocesses.md), [ADR-0022](adr/0022-canonical-provider-neutral-media-model.md), and [ADR-0023](adr/0023-canonical-watch-state-reconciliation.md).
2. Remote provider resource IDs, errors, SDK types, and provider-specific consumer shapes stop at plugin boundaries. Installed provider type IDs and schema-driven configuration are authenticated Nama management resources; public consumers otherwise see Nama concepts. See [ADR-0005](adr/0005-provider-neutral-public-api.md) and [ADR-0019](adr/0019-restricted-schema-driven-provider-configuration.md).
3. Protobuf is the source of truth for every supported Nama client, CLI, and plugin RPC. Better Auth's standard OAuth authorization-server endpoints are the deliberate public authentication exception and are not mirrored through Protobuf. See [ADR-0003](adr/0003-protobuf-connectrpc-boundary.md), [ADR-0004](adr/0004-independent-public-plugin-protobuf-packages.md), [ADR-0007](adr/0007-private-better-auth-adapter.md), and [ADR-0033](adr/0033-better-auth-oauth-device-authorization.md).
4. Media bytes do not pass through the core in normal playback. Locators remain short-lived and restricted to core-validated redirect origins; the selected Apple MVP engine carries the bounded logging and header-replay exceptions recorded in ADR-0032. See [ADR-0013](adr/0013-origin-scoped-short-lived-locators.md) and [ADR-0032](adr/0032-aetherengine-mvp-security-exception.md).
5. A plugin may be restarted or replaced without losing correctness; schedules, credentials, cursors, and reconciliation state belong to the core. See [ADR-0006](adr/0006-stateless-supervised-plugin-subprocesses.md) and [ADR-0024](adr/0024-best-effort-provider-scans.md).
6. Playback-engine types do not escape the universal Apple app's playback adapter. See [ADR-0012](adr/0012-single-playback-engine-adapter.md).
7. New infrastructure or abstraction requires a current use case, not only a plausible future one.
8. The core binds only after configuration, migrations, durable initialization reconciliation, and its initial database probe succeed; Effect scope owns request interruption and resource shutdown. See [ADR-0001](adr/0001-effect-application-graph.md), [ADR-0002](adr/0002-native-node-http-lifecycle.md), [ADR-0008](adr/0008-fail-closed-setup-reconciliation.md), and [ADR-0010](adr/0010-postgresql-drizzle-persistence-boundary.md).
9. Exact operational health routes retain precedence over Connect delegation, and unmatched traffic must never imply an RPC handler exists. See [ADR-0002](adr/0002-native-node-http-lifecycle.md).
10. Generated RPC methods are authorized through one default-deny descriptor inventory. See [ADR-0025](adr/0025-default-deny-rpc-authorization.md).
11. Clients branch on Connect code and stable reason; application failures use standard Google RPC details. See [ADR-0026](adr/0026-standard-google-rpc-error-details.md).
12. Request correlation is distinct from durable logical-operation idempotency. See [ADR-0027](adr/0027-logical-operation-idempotency.md).
13. Recoverable provider credentials use versioned authenticated encryption under a provider-specific derived key, while immutable provider-principal bindings retain only keyed, instance-bound digests. See [ADR-0028](adr/0028-domain-separated-provider-protection.md).
14. One universal Apple app installation has one active endpoint-bound OAuth token bundle. Windows share that authorization while retaining independent transient state, and a replacement becomes active only after the candidate bundle commits durably. See [ADR-0033](adr/0033-better-auth-oauth-device-authorization.md).
15. Better Auth owns device-code state, token issuance, refresh rotation, expiry, revocation endpoints, and cleanup. Connect verifies fixed-client, audience-bound, method-scoped access JWTs locally; Nama adds only broad Administrator revocation of the fixed client's refresh-token families. See [ADR-0033](adr/0033-better-auth-oauth-device-authorization.md).

## Subsystem architecture

- [Core server](architecture/core-server.md)
- [API contracts](architecture/api-contracts.md)
- [Plugin system](architecture/plugin-system.md)
- [Canonical data model](architecture/data-model.md)
- [Watch-state synchronization](architecture/state-sync.md)
- [Authentication, setup, and OAuth authorization](architecture/authentication-and-setup.md)
- [Command-line client](architecture/cli.md)
- [Universal Apple application](architecture/ios-app.md)
- [Playback](architecture/playback.md)
- [Deployment and exposure](architecture/deployment.md)
- [Repository and tooling](architecture/repository-and-tooling.md)

Implementation order, capability sequencing, and release acceptance criteria live in [release-plan.md](release-plan.md). Apply the current-use-case rule in [AGENTS.md](../AGENTS.md#dependencies) rather than reserving architecture for deferred scope.
