# Nama agent guidance

Nama is a self-hosted, tvOS-first Jellyfin control plane. It has a TypeScript/Node core, a Go CLI, a Swift/tvOS app, and a first-party Jellyfin plugin. The core is not a media relay: media travels directly from a provider to the client through safe, short-lived locators.

- `apps/server/` — TypeScript core; the Milestone 0 contract boundary is present, but a server runtime is not.
- `apps/cli/` — Go CLI, a thin client of the public API.
- `apps/tvos/` — SwiftUI tvOS app and Debug-only Player Lab.
- `plugins/jellyfin/` — first-party TypeScript provider adapter.
- `proto/` — authoritative Protobuf schemas and generation configuration.
- `gen/` — committed, Buf-owned generated bindings.

Architecture records in `docs/architecture/` and scoped rules in nested `AGENTS.md` files are separate sources of truth. Read [system architecture](docs/architecture.md) and [API contracts](docs/architecture/api-contracts.md) before changing this repository, then the relevant subsystem record and nested guidance. Their decisions are requirements: change one only when the task explicitly requires it and record the reason in the affected architecture note.

## Ask before you assume

- Ask when a request could reasonably have two meanings, or before changing a public API, Protobuf schema, persistence shape, security boundary, or product decision.
- Do not invent endpoints, provider-specific public shapes, copy, acceptance criteria, or scope beyond the request.
- State any unavoidable assumption in the final summary.
- Implement only the behavior required by the current milestone. Compile-only boundaries prove compilation, not runtime behavior.

## Failure log

- Do not edit `gen/` by hand. Change `proto/` or generation configuration, run `mise run generate`, and commit the regenerated leaves with their source change.
- Do not claim a server, plugin runtime, authentication, or Jellyfin integration exists because generated clients and contract tests compile. Verify an executable entrypoint, handlers, persistence, and startup behavior.
- Do not treat generated Protobuf or Connect round trips as Nama behavior tests. Verify schema format/lint/build, generation drift, consumer compilation, and handwritten Nama policy or adapter behavior.
- Do not build product playback on AetherEngine `6.21.0`: source review rejected it because it leaks locator headers across origins and logs locator URLs in Release.
- Do not weaken or skip an Apple check because the pinned Xcode is absent locally. Use the narrow checks available locally; hosted macOS CI is authoritative for the tvOS check.
- Do not expose provider resource IDs, SDK types, raw provider errors, configuration secrets, reusable credentials, locator URLs, or locator headers across the public boundary or in logs.

## The loop

Every change runs through its owning native check. A task is not done until its relevant checks are green.

```bash
mise tasks                 # inspect the current task surface
mise run check:contracts       # schema format, lint, build, and generated drift
mise run check:ts              # handwritten TypeScript
mise run check:go              # Go formatting, vet, and tests
mise run check:tvos-fixtures   # Player Lab fixture server
mise run check:docker          # Compose model
mise run check                 # all checks; requires the pinned macOS/Xcode toolchain
```

- Write the focused failing test first for new behavior; see it fail for the intended reason, then make it pass.
- Run the narrow check after each meaningful edit. Run `mise run check` on a fully provisioned Mac before calling a cross-workspace change complete.
- Never disable, skip, or focus-only a test to make a result green. If a test is wrong, explain why before changing it.
- Do not use a long-running process as verification. It does not provide a completed result.
- A local prerequisite limitation is evidence to report, not permission to weaken a required check.

## Project structure

```text
apps/
  server/                 # Node 24, strict TypeScript, Effect, ConnectRPC
  cli/                    # Go 1.26 Cobra client of nama.api.v1
  tvos/                   # SwiftUI app; Playback and Debug-only Player Lab
plugins/
  jellyfin/               # stateless nama.plugin.v1 adapter
proto/
  nama/api/v1/            # public api.v1 schema
  nama/plugin/v1/         # private plugin.v1 schema
gen/
  ts/src/                 # generated TypeScript bindings
  go/                     # generated Go bindings
  swift/Sources/NamaAPI/  # generated Swift bindings
docs/architecture/        # canonical technical decisions
.agents/skills/           # project-specific workflows
```

- Put new behavior in the owner that already has responsibility for it. Do not add root-level application code or create empty future packages.
- The core owns identity, configuration, durable state, authorization, schedules, retries, and reconciliation. Plugins are stateless adapters and do not own a database.
- Public `nama.api.v1` is for the core, CLI, and tvOS app. Private `nama.plugin.v1` is only for the core and plugins. The packages do not import each other.
- Keep AetherEngine types inside the single Nama-owned tvOS playback adapter. Do not add an interface until a second engine proves one is needed.

## Dependencies

Code is cheaper than maintenance. Prefer an existing local pattern, the standard library, or a platform feature before adding a dependency.

- Ask before adding a dependency, generator, root task, or platform target. Never add one incidentally while doing other work.
- Native manifests and committed lockfiles own dependencies. Use the owning ecosystem's tool; do not silently update lock state.
- Exact versions are deliberate. Never use `latest` or weaken a lock to make local setup pass.
- Do not introduce Redis, a job framework, a web-management app, a media proxy, a plugin marketplace, a second DI system, or an abstraction without a current accepted use case.

## Naming and public boundaries

Consistency matters more than cleverness. Reuse the established Nama word rather than coining another.

| Concept | Use | Never expose publicly as |
| --- | --- | --- |
| Consumer and management API | `nama.api.v1` | provider-specific services or messages |
| Plugin subprocess API | `nama.plugin.v1` | a consumer API |
| Nama-owned media | canonical item, source, part, track | provider item ID, stream index, filesystem path |
| Installed integration | provider type, provider instance | a dedicated Jellyfin public endpoint |
| Mutation correlation | `operation_id` or `event_id` | a server-synthesized client ID |

- Public IDs are opaque. Compare and return them; do not parse, sort, or synthesize them.
- Protobuf changes are additive: never renumber or reuse fields or enum values, and reserve removed names and numbers.
- Put provider-specific translation and remote identity in the plugin. Public consumers receive Nama-owned, provider-neutral values.
- Keep secrets write-only and out of responses, diagnostics, errors, logs, and spans.

## Errors, logging, and performance

Fail early, fail clearly, and never swallow a failure.

- At every trust boundary, validate input and return the documented Connect code plus stable Nama reason and safe field details where applicable.
- Normalize external failures at the adapter boundary. Unexpected defects remain internal and expose only a correlation ID to clients.
- Use structured, allowlisted log fields. Never log request bodies, arbitrary headers, passwords, tokens, database URLs, configuration values, provider credentials, locator URLs, or locator headers.
- The API p95 budget is 200ms. Once runnable server traffic exists, propose and implement a concrete latency-monitoring path before claiming the budget is met; do not add a metrics backend speculatively today.
- Filter, sort, aggregate, and paginate in PostgreSQL when persistence exists. Avoid unbounded reads, `select *`, and N+1 request paths.

## End-to-end and UI verification

- A feature that crosses client, core, plugin, or database boundaries needs an exercised real flow when those runtime pieces exist; unit or compile checks alone are not enough.
- For tvOS work, inspect every changed screen visually. On real playback changes, exercise the Player Lab on physical Apple TV hardware and record actual device/display results; a simulator build is not playback proof.
- Check loading, empty, failure, focus, accessibility, and long-content states. No critical action may exist only as an undiscoverable gesture.
- Never report an unrun hardware, provider, or security row as passing. Keep the limitation and its evidence in the final summary.

## Keeping this file current

This is a failure log, not a wishlist. Every line exists because it protects a real Nama decision or prior failure.

When a correction reveals durable repository knowledge:

1. Add one imperative, Nama-specific line here.
2. Put a repeatable workflow in `.agents/skills/` and link it here when a one-line rule is insufficient.
3. Keep architecture decisions in `docs/architecture/` and subtree rules in their nested `AGENTS.md` files; do not duplicate them here.
4. Include the update in the same commit and mention it in the summary.

Keep this file below 500 lines. Move a section that outgrows its usefulness to the owning architecture record, subtree guidance, or project skill.
