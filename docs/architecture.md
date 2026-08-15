# Nama System Architecture

Status: accepted technical direction for the MVP.

Read [philosophy.md](philosophy.md) for the product intent. This document is the canonical index of system boundaries and technology choices every agent must preserve. Its decisions are requirements, not a menu: change one only when a task explicitly calls for it, and record the reason here and in the affected subsystem note.

The linked subsystem notes are concise decision records, not implementation specifications. Consult the relevant note before changing a subsystem.

## System shape

Nama's target MVP is a self-hosted control plane, not a media relay. A TypeScript core owns identity, configuration, the canonical media model, watch state, reconciliation, and authorization. Provider plugins translate between that model and external services. Native clients and the Go CLI use one versioned Protobuf/ConnectRPC contract. During playback the provider sends media directly to the client; the core only selects and authorizes the source.

```text
Apple app ──────────────┐
Go CLI ── Connect api.v1├──> Node core ───> Drizzle ORM ───> PostgreSQL
                        │        │
                        │        └── Connect plugin.v1 over Unix socket
                        │                         │
                        │                  Jellyfin plugin ───> Jellyfin API
                        │                         │
Apple player <──────────┴──────── playable URL ──┘
```

The installable MVP is intentionally narrow: one private deployment, one administrator, Jellyfin as the only provider type, and one universal SwiftUI client targeting iOS, tvOS, and macOS; more than one Jellyfin instance may be configured when the administrator needs multiple watch-state inputs. The architecture keeps the public and plugin contracts real from the first vertical slice, but does not build a marketplace, web console, generic workflow engine, distributed queue, or native media server in anticipation of later releases.

The implemented core baseline is narrower than the target topology: `@nama/server` boots as one Effect application, decodes immutable configuration, applies reviewed Drizzle migrations for the Better Auth core tables and Nama's durable initialization marker over one PostgreSQL pool, transactionally reconciles that marker fail-closed, probes the database, serves exact liveness/readiness routes, emits safe structured logs, and shuts down deterministically. Better Auth configuration and CLI tooling own the committed generated auth schema; Drizzle owns reviewed SQL and runtime migration application over that existing pool. The process does not yet import or mount Better Auth, expose setup or authentication handlers, register Connect handlers, supervise plugins, or implement product RPC behavior; all non-health HTTP targets currently return 404. [Core server](architecture/core-server.md) owns this implementation boundary and the approved extension points.

## Decision index

| Area | Decision |
| --- | --- |
| Core | Node.js 24 LTS, strict TypeScript, ESM, exact-pinned Effect v4 beta, pnpm, one Effect application graph, and a scoped native Node HTTP listener. |
| Public API | Protobuf managed by Buf; ConnectRPC `api.v1`; unary RPCs first. |
| Plugin API | Separate ConnectRPC `plugin.v1`; supervised subprocesses over Unix domain sockets. |
| Authentication | Better Auth is a server-side implementation detail behind Nama-owned Setup, Auth, and Device RPCs. |
| Persistence | Better Auth configuration and CLI tooling own committed generated auth tables; Drizzle owns reviewed SQL and runtime application over one shared PostgreSQL `pg.Pool`. |
| Background work | A core-owned scheduler with durable database cursors; no Redis or job framework for MVP. |
| First plugin | A stateless Jellyfin adapter for catalog, playback negotiation, and two-way watch-state sync. |
| First client | One universal Swift/SwiftUI app in `apps/ios`, targeting iOS 17+, tvOS 17+, and macOS 14+, with Connect-Swift, Keychain, and native Bonjour discovery. |
| Playback | An exact-pinned, security-reviewed on-device engine behind one Nama-owned adapter; direct play, then remux, then transcode. |
| Administration | A thin Go 1.26 CLI using the generated Connect client; no management web app for MVP. |
| Deployment | Linux-first Docker image containing core and first-party plugin executables, plus a separate PostgreSQL service. |
| Exposure | Nama does not manage domains, certificates, tunnels, or reverse proxies; users choose LAN, VPN, or proxy access. |
| Repository | One repository with native tooling for TypeScript, Go, Swift, and Protobuf; mise pins command-line tools and delegates common tasks without becoming a build framework. |

Exact dependency versions are lockfile decisions, not promises in this document. Releases pin and test them; upgrades are deliberate, especially the playback engine and pre-1.0 client libraries.

## Invariants

1. The core is the source of truth for Nama-owned user and watch state; plugins never become hidden databases.
2. Remote provider resource IDs, errors, SDK types, and provider-specific consumer shapes stop at plugin boundaries. Installed provider type IDs and schema-driven configuration are authenticated Nama management resources; public consumers otherwise see Nama concepts.
3. Protobuf is the source of truth for every supported client, CLI, and plugin RPC; auth is not a second client SDK.
4. Media bytes do not pass through the core in normal playback.
5. A plugin may be restarted or replaced without losing correctness; schedules, credentials, cursors, and reconciliation state belong to the core.
6. Playback-engine types do not escape the universal Apple app's playback adapter.
7. New infrastructure or abstraction requires a current use case, not only a plausible future one.
8. The core binds only after configuration, migrations, durable initialization reconciliation, and its initial database probe succeed; Effect scope owns request interruption and resource shutdown.
9. Exact operational health routes retain precedence when Connect delegation is added, and unmatched traffic must never imply an RPC handler exists.

## Subsystem decisions

- [Core server](architecture/core-server.md)
- [API contracts](architecture/api-contracts.md)
- [Plugin system](architecture/plugin-system.md)
- [Canonical data model](architecture/data-model.md)
- [Watch-state synchronization](architecture/state-sync.md)
- [Authentication, setup, and pairing](architecture/authentication-and-setup.md)
- [Management CLI](architecture/cli.md)
- [iOS application](architecture/ios-app.md)
- [Playback](architecture/playback.md)
- [Deployment and exposure](architecture/deployment.md)
- [Repository and tooling](architecture/repository-and-tooling.md)

Implementation order and release acceptance criteria live in [release-plan.md](release-plan.md).

## Deferred until evidence demands them

Multi-user roles and invitations, browser and Android clients, third-party plugin installation, WASM isolation, per-plugin persistent storage, a durable job framework, provider event streams, an embedded reverse proxy, a management web application, and a native library/transcode plugin are outside the MVP. Each should be introduced by a concrete feature with a testable need; this architecture does not reserve machinery for them.
