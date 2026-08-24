# Nama agent guidance

Nama is a self-hosted, iOS-first Jellyfin control plane. It has a TypeScript/Node core, a Go CLI, one universal SwiftUI application targeting iOS, tvOS, and macOS through the generated Swift bindings, and a first-party Jellyfin plugin. The core is not a media relay: media travels directly from a provider to the client through safe, short-lived locators.

- `apps/server/` — executable TypeScript core; its one-listener Connect runtime implements Administrator setup and authentication, bundled-provider discovery and reconciliation, provider-type listing, candidate and exact-revision stored-instance connection tests, and verified provider-instance create/list/get/update/delete including disable and re-enable. Device pairing and consumer behavior beyond manual endpoint verification remain unimplemented.
- `apps/cli/` — Go public-API client surface; named server profiles, Administrator setup and sign-in, authentication status, provider-type listing, and provider-instance create/list/get/update/delete are implemented. The remaining management command families are unimplemented.
- `apps/ios/` — universal SwiftUI application and Swift Testing target; manual Nama endpoint normalization, explicit foreground `_nama._tcp` discovery, cancellable public setup-status verification, safe connection states, verified endpoint preference persistence and restoration, native form/tvOS presentation, and the macOS outgoing-network sandbox are implemented. Pairing and media behavior remain unimplemented.
- `plugins/jellyfin/` — first-party TypeScript provider adapter; its production executable implements private health, provider information, connection inspection, targeted normalized library reads, resumable best-effort catalog and movie/episode watch-state scans with bounded safe failures, exact-instance targeted movie/episode watch-state reads, anonymous public artwork resolution, and bounded explicit watched/unwatched writes with ambiguity readback. It advertises `LIBRARY_READ`, `ARTWORK_RESOLVE`, `WATCH_STATE_READ`, and `WATCHED_WRITE`; the remaining media capabilities are unimplemented.
- `proto/` — authoritative Protobuf schemas and generation configuration.
- `gen/` — committed, Buf-owned generated bindings.

Repository authority is role-based: [CONTEXT.md](CONTEXT.md) owns domain language; accepted [ADRs](docs/adr/) own architectural choices and rationale; [system architecture](docs/architecture.md) and its subsystem notes own current and target shape; contracts own required behavior; and [Protobuf](proto/) owns concrete wire definitions. Before changing this repository, read `CONTEXT.md`, the system architecture, and API contracts, then the relevant subsystem note, contract, ADR, and nested guidance.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `electather/nama`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the canonical `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix` labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: [CONTEXT.md](CONTEXT.md) owns domain language, accepted [ADRs](docs/adr/) own choices and rationale, and [architecture](docs/architecture.md) owns the current and target system shape. See [domain guidance](docs/agents/domain.md).

## Ask before you assume

- Ask when a request could reasonably have two meanings, or before changing a public API, Protobuf schema, persistence shape, security boundary, or product decision.
- Do not invent endpoints, provider-specific public shapes, copy, acceptance criteria, or scope beyond the request.
- State any unavoidable assumption in the final summary.
- Implement only the behavior required by the current milestone. Compile-only boundaries prove compilation, not runtime behavior.

## Failure log

- Do not edit `gen/` by hand. Change `proto/` or generation configuration, run `mise run generate`, and commit the regenerated leaves with their source change.
- Never hand-edit `apps/server/src/database/auth-schema.ts`. Change `apps/server/better-auth.config.ts`, run `pnpm --filter @nama/server run generate:auth-schema`, and commit the generated output with its source change.
- In handwritten server ESM source, use `.ts` on relative imports; retain generator-owned `.js` imports in generated packages.
- Do not use TypeScript parameter properties in Node 24 strip-only executable paths.
- Keep the committed Drizzle compatibility patch declaration-only; never change its runtime JavaScript or weaken strict TypeScript, including through `skipLibCheck`.
- Do not claim a server, plugin runtime, authentication, or Jellyfin integration exists because generated clients and contract tests compile. Verify an executable entrypoint, handlers, persistence, and startup behavior.
- Force the pinned Jellyfin 10.11.11 integration services to `linux/amd64` on Apple Silicon, and require `StartupWizardCompleted` in their healthcheck; its arm64 image exits 132 and its public endpoint becomes reachable before startup data is complete.
- Give PostgreSQL activity-state integration polls enough wall-clock time for a cold `nama-server` process to reach migrations under the parallel repository check; a one-second poll expires before lock admission.
- Do not treat generated Protobuf or Connect round trips as Nama behavior tests. Verify schema format/lint/build, generation drift, consumer compilation, and handwritten Nama policy or adapter behavior.
- For `google.protobuf.Struct` field-level Protovalidate CEL, use `this.size()`, not `this.fields.size()`; Protovalidate-ES exposes the WKT as a JSON object and the latter fails at runtime.
- Pin AetherEngine `6.21.0` and its complete resolved dependency closure. ADR-0032 permits only its local Release locator-URL logging and locator-header replay between core-allowlisted origins for the MVP; never widen that exception.
- Do not claim generic Apple-platform builds prove runtime behavior; inspect the actual universal application on every affected platform and keep unrun physical-device rows explicit.
- Scope each universal-app connection feature to one window; when its scene leaves the foreground, cancel only the active verification, and treat a remote Connect `canceled` response as a safe visible failure rather than local cancellation.
- Keep array-valued `NSBonjourServices` in the Apple app's partial Info property list; generated `INFOPLIST_KEY_*` build settings do not emit the Bonjour array.
- Never copy a restored endpoint into the live manual-entry binding; its `onChange` intentionally cancels active verification as a user edit.
- Keep Nama endpoint RPCs on the Nama-owned unary URLSession transport; Connect's default URLSession client follows redirects before Nama can reject their targets.
- Do not expose provider resource IDs, SDK types, raw provider errors, configuration secrets, reusable credentials, locator URLs, or locator headers across the public boundary.
- Hold each provider-instance supervisor admission fence through durable update resolution; release it only after pinning the committed or recovered revision, and leave it closed while durable truth remains ambiguous.
- Route every provider-instance core activity through the provider-management scoped activity gate; never replace the production deletion fence with a no-op or test-only hook.
- Retain a provider delete's scoped activity fence while its database result is ambiguous; only an exact retry with the same Administrator, operation ID, and expected revision may reuse that ownership.
- Contain unreadable provider credentials only after persistence identifies the affected instance; an unscoped installation-configuration recovery failure remains fail-closed and must not be treated as schema compatibility.
- Keep update-commit ambiguity state separate from retained delete-fence ownership; a non-delete mutation must fail while an ambiguous delete still owns the instance activity fence.
- On a Nama fatal setup-commit ambiguity, make local `GetStatus` fail `UNAVAILABLE/SETUP_UNAVAILABLE` until exit; never report `initialized=false`.
- While a Nama bootstrap attempt is active, return `SETUP_IN_PROGRESS` only for its matching token; every other candidate fails `AUTHENTICATION_FAILED`.
- Emit Nama `server.runtime_failed` at `fatal` severity so configured `warn`, `error`, and `fatal` thresholds retain it.
- Pass eligible non-loopback interface names to Ciao's responder as well as restricted addresses; on Darwin, an empty ARP table can leave autodetection with loopback only while `advertise()` still reports success.
- Join the LAN-advertisement fiber from its owning scope finalizer; Effect's built-in scoped-fiber finalizer ignores the child exit, which would otherwise turn responder-shutdown failure into successful process shutdown.

## The loop

Every change runs through its owning native check. A task is not done until its relevant checks are green.

```bash
mise tasks                 # inspect the current task surface
mise run check:contracts   # schema format, lint, build, and generated drift
mise run check:ts          # TypeScript and auth-schema drift
mise run check:go          # Go formatting, vet, and tests
mise run check:docker      # Compose model
mise run check             # all current repository checks
```

- Write the focused failing test first for new behavior; see it fail for the intended reason, then make it pass.
- Run the narrow check after each meaningful edit. Run `mise run check` before calling a cross-workspace change complete.
- Never disable, skip, or focus-only a test to make a result green. If a test is wrong, explain why before changing it.
- Do not use a long-running process as verification. It does not provide a completed result.
- A local prerequisite limitation is evidence to report, not permission to weaken a required check.

## Project structure

```text
apps/
  server/                 # Node 24, strict TypeScript, Effect, ConnectRPC
  cli/                    # Go 1.26 Cobra client of nama.api.v1
  ios/                    # universal SwiftUI app using generated nama.api.v1
plugins/
  jellyfin/               # stateless nama.plugin.v1 adapter
proto/
  nama/api/v1/            # public api.v1 schema
  nama/plugin/v1/         # private plugin.v1 schema
gen/
  ts/src/                 # generated TypeScript bindings
  go/                     # generated Go bindings
  swift/Sources/NamaAPI/  # generated Swift bindings
docs/adr/                 # accepted architectural choices and rationale
docs/architecture/        # current and target living architecture
scripts/                  # multi-step implementations of Mise tasks
.agents/skills/           # project-specific workflows
```

- Put new behavior in the owner that already has responsibility for it. Do not add root-level application code or create empty future packages.
- The core owns identity, configuration, durable state, authorization, schedules, retries, and reconciliation. Plugins are stateless adapters and do not own a database.
- Public `nama.api.v1` is for the core, CLI, and universal app rooted in `apps/ios`. Private `nama.plugin.v1` is only for the core and plugins. The packages do not import each other.
- Keep selected playback-engine types inside the universal Apple app's single Nama-owned playback adapter. Do not add an interface until a second engine proves one is needed.

## Dependencies

Code is cheaper than maintenance. Prefer an existing local pattern, the standard library, or a platform feature before adding a dependency.

- Ask before adding a dependency, generator, root task, or platform target. Never add one incidentally while doing other work.
- Native manifests and committed lockfiles own dependencies. Use the owning ecosystem's tool; do not silently update lock state.
- Exact versions are deliberate. Never use `latest` or weaken a lock to make local setup pass.
- Do not introduce Redis, a job framework, a web-management app, a media proxy, a plugin marketplace, a second DI system, or an abstraction without a current accepted use case.

## Naming and public boundaries

Use the exact domain language in [CONTEXT.md](CONTEXT.md). The following table constrains public-boundary vocabulary; it does not define the domain.

| Concept | Use | Never expose publicly as |
| --- | --- | --- |
| Consumer and management API | `nama.api.v1` | provider-specific services or messages |
| Plugin subprocess API | `nama.plugin.v1` | a consumer API |
| Nama-owned media | canonical item, source, part, track | provider item ID, stream index, filesystem path |
| Installed integration | provider instance | a dedicated Jellyfin public endpoint |
| Mutation correlation | `operation_id` or `event_id` | a server-synthesized client ID |

- Public IDs are opaque. Compare and return them; do not parse, sort, or synthesize them.
- Protobuf changes are additive: never renumber or reuse fields or enum values, and reserve removed names and numbers.
- Put provider-specific translation and remote identity in the plugin. Public consumers receive Nama-owned, provider-neutral values.
- Keep secrets write-only and out of responses, diagnostics, errors, logs, and spans.

## Errors, logging, and performance

Fail early, fail clearly, and never swallow a failure.

- At every trust boundary, validate input and return the documented Connect code plus stable Nama reason and safe field details where applicable.
- Normalize external failures at the adapter boundary. Unexpected defects remain internal and expose only a correlation ID to clients.
- Use structured, allowlisted log fields. Nama-owned code never logs request bodies, arbitrary headers, passwords, tokens, database URLs, configuration values, provider credentials, locator URLs, or locator headers. ADR-0032's AetherEngine-local MVP exception is not persisted, uploaded, or exposed through product diagnostics.
- The API p95 budget is 200ms. Once runnable server traffic exists, propose and implement a concrete latency-monitoring path before claiming the budget is met; do not add a metrics backend speculatively today.
- Filter, sort, aggregate, and paginate in PostgreSQL when persistence exists. Avoid unbounded reads, `select *`, and N+1 request paths.

## End-to-end and UI verification

- A feature that crosses client, core, plugin, or database boundaries needs an exercised real flow when those runtime pieces exist; unit or compile checks alone are not enough.
- For universal Apple app work, inspect every changed screen on each affected platform. Real playback changes require representative physical iPhone or iPad, Apple TV, and Mac hardware with recorded device/display results; simulator builds are not playback proof.
- Check loading, empty, failure, focus, accessibility, and long-content states. No critical action may exist only as an undiscoverable gesture.
- Never report an unrun hardware, provider, or security row as passing. Keep the limitation and its evidence in the final summary.

## Keeping this file current

This is a failure log, not a wishlist. Every line exists because it protects a real Nama decision or prior failure.

When a correction reveals durable repository knowledge:

1. Add one imperative, Nama-specific line here.
2. Put a repeatable workflow in `.agents/skills/` and link it here when a one-line rule is insufficient.
3. Keep domain language in `CONTEXT.md`, accepted choices and rationale in `docs/adr/`, current and target shape in `docs/architecture/`, required behavior in contract notes, and concrete wire definitions in `proto/`; keep subtree rules in their nested `AGENTS.md` files.
4. Include the update in the same commit and mention it in the summary.

Keep this file below 500 lines. Move a section that outgrows its usefulness to the owning architecture record, subtree guidance, or project skill.
