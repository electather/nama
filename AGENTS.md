# Nama agent guidance

Nama is a self-hosted, iOS-first Jellyfin control plane. It has a TypeScript/Node core, a Go CLI, one universal SwiftUI application targeting iOS, tvOS, and macOS through the generated Swift bindings, and a first-party Jellyfin plugin. The core stores and serves bounded canonical artwork assets but is not a playable-media relay: playable media travels directly from a provider to the client through safe, short-lived locators.

- `apps/server/` — executable TypeScript core; its one-listener Connect runtime implements Administrator setup and authentication, Better Auth device authorization and refresh, locally verified scoped OAuth consumer authority, fixed-Apple-client refresh-family revocation, bundled-provider discovery and reconciliation, provider-type listing, candidate and exact-revision stored-instance connection tests, verified provider-instance create/list/get/update/delete including disable and re-enable, durable initial provider-catalog and bounded artwork-asset ingestion with exact canonical mapping, sparse canonical Watch state and exact Provider replica persistence, and authenticated stored canonical Library and signed artwork-asset reads. Playback and user-state consumer handlers remain unimplemented.
- `apps/cli/` — Go public-API client surface; named server profiles, Administrator setup and sign-in, authentication status, authenticated device approval, fixed-Apple-client refresh revocation, provider-type listing, and provider-instance create/list/get/update/delete are implemented. The remaining management command families are unimplemented.
- `apps/ios/` — universal SwiftUI application and Swift Testing target; manual Nama endpoint normalization, explicit foreground `_nama._tcp` discovery, cancellable public setup-status verification, safe connection states, verified endpoint preference persistence and restoration, native Better Auth device authorization and refresh, endpoint-bound Keychain storage, provider-neutral Home, paginated Movie/Show Library, and debounced all-kind Search over stored canonical media with safe artwork, canonical Movie/Show/Season/Episode Details hierarchy with typed Play intents, native form/tvOS presentation, and the macOS outgoing-network sandbox are implemented. Watch State and playback product behavior remain unimplemented.
- `plugins/jellyfin/` — first-party TypeScript provider adapter; its production executable implements private health, provider information, connection inspection, targeted normalized library reads, resumable best-effort catalog and movie/episode watch-state scans with bounded safe failures, exact-instance targeted movie/episode watch-state reads, bounded artwork-acquisition leases, anonymous public provider artwork fetches, bounded explicit watched/unwatched writes with ambiguity readback, the complete extension-backed progressive/HLS playback, fallback, Track, and telemetry lifecycle, and coherent extension progress writes. Stock connections advertise `LIBRARY_READ`, `ARTWORK_RESOLVE`, `WATCH_STATE_READ`, and `WATCHED_WRITE`; a compatible extension handshake adds `PLAYBACK_PLAN`, `PLAYBACK_OPEN`, `PLAYBACK_REPORT`, `PLAYBACK_REPORTS_USER_STATE`, and `PROGRESS_WRITE` only for its corresponding declared features.
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
- In Drizzle raw catalog subqueries, interpolate physical tables in `from` clauses and qualify correlated outer columns explicitly; interpolating `alias(...)` there emits the alias as a nonexistent relation.
- When a generated Drizzle migration adds required columns to populated tables or rebuilds referenced uniqueness, drop dependent foreign keys first, add nullable columns, backfill, enforce `NOT NULL`, create referenced uniqueness, and only then restore foreign keys.
- When moving a Drizzle check constraint between modules, preserve its exact SQL template whitespace or regenerate the owning unreleased migration; rendered whitespace is snapshot-significant and otherwise creates a spurious drop-and-recreate migration.
- Do not claim a server, plugin runtime, authentication, or Jellyfin integration exists because generated clients and contract tests compile. Verify an executable entrypoint, handlers, persistence, and startup behavior.
- Force the pinned Jellyfin 10.11.11 integration services and extension-build SDK to `linux/amd64` on Apple Silicon, and require `StartupWizardCompleted` in their healthcheck; their arm64 images exit 132 and Jellyfin's public endpoint becomes reachable before startup data is complete.
- In the Docker gate, assert candidate cleanup before creating a stored provider instance; before killing an instance child, wait for initial catalog retirement and prove the new child owns a TCP connection to Jellyfin, because PID presence alone races lazy launch and recovery.
- Run the restart-mutating real Jellyfin provider proof only after every other shared-fixture server test; restarting the Compose service interrupts concurrent consumers and can republish its ephemeral host port.
- Give PostgreSQL activity-state integration polls enough wall-clock time for a cold `nama-server` process to reach migrations under the parallel repository check; a one-second poll expires before lock admission.
- Give compiled-process liveness, bootstrap-output, and plugin-supervisor retirement-finalization assertions twenty seconds under the parallel repository check; a five-second test budget can expire before cold Node startup or orderly process retirement under concurrent Apple and container builds.
- Give end-to-end bootstrap process scenarios sixty seconds while retaining twenty-second individual readiness and output polls; database preparation and cold startup share the outer test budget.
- Give multi-page production Jellyfin catalog replacement proofs ten seconds; the default five-second test budget can expire under the parallel server check.
- Poll state or start filesystem watchers before their initial read in process-test await helpers; reading first and subscribing second can miss the only fast fixture transition and hang indefinitely.
- Await process-exit, recovery, and retirement lifecycle log effects before dependent transitions, and persist blocked-fixture cancellation evidence before rejecting the request; fire-and-forget observation races flake lifecycle proofs.
- Snapshot intentional-stop state in each child exit record and mark RPC-observed unexpected exits before recovery; reading mutable stop state in a delayed watcher suppresses genuine exit logs.
- Keep candidate cancellation retirement proof separate from request-cancellation acknowledgement; forced one-shot teardown can terminate the fixture before its remote handler persists cancellation.
- Give the compiled provider-discovery process integration flow sixty seconds under the parallel Linux check; runner contention makes its multi-operation proof exceed thirty seconds.
- Assert secret absence with complete sensitive values, not short URL fragments such as ephemeral ports that can collide with request IDs, timestamps, or durations.
- Do not treat generated Protobuf or Connect round trips as Nama behavior tests. Verify schema format/lint/build, generation drift, consumer compilation, and handwritten Nama policy or adapter behavior.
- For `google.protobuf.Struct` field-level Protovalidate CEL, use `this.size()`, not `this.fields.size()`; Protovalidate-ES exposes the WKT as a JSON object and the latter fails at runtime.
- For issue #145, keep the Apple client's Better Auth device-code, token, refresh, metadata, JWKS, and revocation protocol on native HTTP endpoints; never mirror that OAuth client protocol through Connect or add parallel Pairing, Device, digest, delivery, replay, or cleanup persistence.
- Keep issue #145 browser-free, CLI-uniform, and role-neutral: `AuthService.ApproveDeviceAuthorization` must derive the grant subject only from the authenticated session context and pass that context to Better Auth's internal `deviceVerify` then `deviceApprove` APIs without a target user ID, Administrator-role check, public approval routes, loopback HTTP, or direct Better Auth persistence access; browser sign-in and confirmation belong to issue #167 and reuse the same internal application service.
- Treat Better Auth sessions and OAuth access JWTs as distinct authorities. Validate JWT signature, issuer, exact audience, expiry, fixed client ID, and method-specific scope without failed-OAuth fallback to session resolution or inherited Administrator authority.
- Keep Better Auth's authorization-server issuer distinct from the exact canonical Nama resource: the issuer omits the trailing slash while the audience/resource retains it.
- Reconcile the fixed OAuth resource through the Database owner before Better Auth construction and configure only its cached identifier at runtime; Better Auth's asynchronous `resources` boot seed can outlive the Effect-owned pool and crash startup.
- Better Auth's OAuth device grant creates no `oauthConsent` row. Revoke the fixed Apple client's refresh-token families through the narrow Administrator operation; never claim consent deletion revokes lost offline grants or that locally verified JWT revocation is immediate.
- ADR-0033 deliberately keeps the acknowledged eligible local-HTTP exception for session and OAuth credentials despite Better Auth's HTTPS guidance; never widen it beyond loopback, private, link-local, `localhost`/`.localhost`, or `.local`, and never describe it as transport-secure.
- Issue #145 is the sole accepted pre-release exception to additive public Protobuf evolution: remove the unimplemented `DeviceService`, add only role-neutral `AuthService.ApproveDeviceAuthorization` and Administrator-only `AuthService.RevokeAppleClientRefreshTokens`, reserve removed fields and enum values where supported, regenerate every consumer in the same change, and advance the breaking baseline.
- Pin AetherEngine `6.21.0` and its complete resolved dependency closure. ADR-0032 permits only its local Release locator-URL logging and locator-header replay between core-allowlisted origins for the MVP; never widen that exception.
- Route every remote media, playlist child, key, and external-subtitle request through Nama's session-scoped loopback bridge; AetherEngine `6.21.0` cannot enforce `allowed_redirect_origins`, so never pass upstream Locator URLs or headers directly.
- Keep the manually installed Jellyfin server extension distinct from the supervised provider plugin: the .NET extension owns host validation, protected lease keys, media interposition, and coherent user-data writes, while the TypeScript plugin alone translates its private JSON/HTTP protocol into `nama.plugin.v1`.
- Advertise Jellyfin extension-backed playback and coherent-progress capabilities only after an authenticated compatible extension handshake; a missing, unhealthy, or incompatible extension leaves the implemented stock capabilities unchanged.
- Keep extension-capable Jellyfin test handshakes on protocol version `2`; use version `1` only to prove incompatible fallback.
- Require an actual Jellyfin API key on every private `/Nama/v1` control endpoint; never accept a user/device access token or label one as an API key in integration fixtures.
- Bound the optional extension handshake independently from `GetConnection`; a stalled or unhealthy extension must preserve the already-verified stock capability result while caller cancellation still propagates.
- Build the Jellyfin extension's playback Data Protection provider outside Jellyfin's host service collection; never configure the host-wide provider for extension lease keys.
- Extract the packaged Jellyfin extension archive before fixture startup and mount its DLL into a writable plugin directory; a read-only directory prevents Jellyfin from writing `meta.json`.
- Compile extension fault injection through a non-incremental Debug build after
  every Release build and test, then explicitly replace the release-extracted
  fixture DLL; never ship fault injection in the release archive.
- Exercise the packaged Release DLL in a separate pinned Jellyfin fixture before replacing the fault fixture with `NAMA_TEST_FAULTS` Debug; build and archive checks are not runtime proof.
- Keep release playback expiry at a five-minute plan and thirty-minute session
  grace; only the `NAMA_TEST_FAULTS` fixture uses two seconds and two minutes so
  the real-provider gate can prove both expiries without weakening assertions.
- Resolve an operation- and request-bound successful playback open before enforcing plan expiry, and retain that replay binding for the playback session lifetime.
- Reject a disabled configured Jellyfin user during both playback Plan and Open; a prior connection check or current extension handshake does not preserve principal eligibility.
- Retain exact local ambiguity identities and admitted sequence or terminal state when an Open, Report, or Close provider mutation throws; identical retries return ambiguity without re-entering Jellyfin.
- Revalidate source protocol, open/close requirements, runtime equality, and lifetime bounds during playback Open before any Jellyfin session mutation.
- Keep extension plan identifiers within the plugin contract's 256-character bound and advertise only track choices that `OpenPlayback` can materialize.
- Tamper protected base64url fixture values in a non-final character and ensure
  the replacement differs; changing the last character can preserve decoded
  bytes through unused bits or leave the value unchanged.
- Keep every Nama-exposed Jellyfin media, playlist child, key, and subtitle URL in the opaque extension namespace with a scoped header; never expose stock paths, provider IDs, `ApiKey`, or broad authorization.
- Enforce Jellyfin control-document byte limits while accepting stock writes and while constructing rewritten output; a post-buffer length check does not bound memory.
- Remint safe same-origin Jellyfin media redirects as session-bound opaque resources and suppress redirect bodies; reject every unsafe target without forwarding its `Location`.
- Normalize every non-success opaque stock-media response to an empty safe response with cleared provider headers; broad-API-key stock diagnostics never cross the extension boundary.
- Treat independently discovered stock Jellyfin routes as outside Nama's scoped-access guarantee; never claim that the extension hardens or changes their behavior.
- Keep the macOS incoming-network entitlement confined to `NamaPlayer`'s ephemeral broker and keep that listener bound to exact IPv4 loopback; never widen it to an any, link-local, or LAN endpoint.
- Keep PR CI on a selected Actions allowlist that admits GitHub-owned actions and `jdx/mise-action`, and run `mise run check:swift` on `macos-26`; the Swift check invokes `xcodebuild` and cannot run on Ubuntu.
- Run Swift CodeQL as a manual one-architecture x86_64 build on `macos-26-intel`; CodeQL initialization exposes only an x86_64 macOS destination even on an arm64 runner, while default autobuild selects an unqualified Release target, rebuilds universal AetherEngine dependencies, and eventually fails dependency module resolution.
- Do not claim generic Apple-platform builds prove runtime behavior; inspect the actual universal application on every affected platform and keep unrun physical-device rows explicit.
- Use an Apple Development-signed sandboxed macOS build for actual-surface acceptance; an ad hoc-signed sandboxed build can stay alive without creating a window and is not runtime proof.
- Use a signed simulator build for OAuth Keychain acceptance; `CODE_SIGNING_ALLOWED=NO` makes the Keychain path fail unavailable even when transport and device-code UI run.
- Give macOS-hosted real-engine playback assertions thirty seconds under the parallel repository check; aggregate compiler, container, and server-test load can delay track and control publication past twenty seconds.
- In real-engine injected-HLS subtitle tests, wait for the `AVPlayerItem`
  legible selection to apply and clear before teardown; Nama's selected Track
  ID publishes before AetherEngine's asynchronous media-selection task completes.
- Keep static Apple loading surfaces focusable without a visible focus effect on
  tvOS and macOS; an interaction-free scene can stay alive without presenting a
  usable foreground window.
- On tvOS Details, eagerly materialize bounded child and playback actions,
  assign initial focus to the first actionable row or button, and keep explicit
  Back and in-flow Refresh controls; lazy offscreen rows plus toolbar-only
  actions can trap focus in the top-level tabs.
- Wrap heterogeneous Nama `NavigationLink` values in one compatible navigation
  destination type; a homogeneous typed path silently ignores links whose value
  has another type.
- On macOS, do not cancel Home from `HomeView.onDisappear`; SwiftUI can remove
  that view transiently while the same visible window still owns its initial
  load. Cancel Home from scene-phase, authorization, and semantic top-level
  transitions instead.
- After collapsing a custom SwiftUI button with
  `.accessibilityElement(children: .ignore)`, restore `.isButton`; otherwise
  assistive technologies expose the action as a non-actionable element.
- On tvOS Details, make refresh recovery focus win over Play, Retry, Sources,
  and child initial-focus requests; when a focused child disappears, restore its
  exact opaque identity if it survives, otherwise choose the row at its retained
  presentation position or the preceding row when the removed row was last.
- Scope each universal-app connection feature to one window; when its scene leaves the foreground, cancel only the active verification, and treat a remote Connect `canceled` response as a safe visible failure rather than local cancellation.
- Keep array-valued `NSBonjourServices` in the Apple app's partial Info property list; generated `INFOPLIST_KEY_*` build settings do not emit the Bonjour array.
- Never copy a restored endpoint into the live manual-entry binding; its `onChange` intentionally cancels active verification as a user edit.
- Keep Nama endpoint RPCs on the Nama-owned unary URLSession transport; Connect's default URLSession client follows redirects before Nama can reject their targets.
- Do not expose provider resource IDs, SDK types, raw provider errors, configuration secrets, reusable credentials, locator URLs, or locator headers across the public boundary.
- Preserve PostgreSQL microsecond precision in date-added page-token cursors; converting a `timestamptz` cursor through JavaScript `Date` can skip later rows from the same millisecond.
- Format compact Jellyfin UUID item references as hyphenated UUIDs and omit cache tags in provider artwork-acquisition requests so stored private references never leave the import seam.
- Treat absent artwork `access_expires_at` as valid in the Apple locator adapter when no scoped headers are present; never optional-bind an intentionally absent timestamp inside a multi-clause validation guard.
- Hold each provider-instance supervisor admission fence through durable update resolution; release it only after pinning the committed or recovered revision, and leave it closed while durable truth remains ambiguous.
- Route every provider-instance core activity through the provider-management scoped activity gate; never replace the production deletion fence with a no-op or test-only hook.
- Retain a provider delete's scoped activity fence while its database result is ambiguous; only an exact retry with the same Administrator, operation ID, and expected revision may reuse that ownership.
- Serialize each provider instance's catalog item transactions on its provider row before exact mapping and hierarchy repair, and read each canonical aggregate from one repeatable-read snapshot; otherwise concurrent parent/child observations or replacements can leave unpublished or mixed projections.
- Determine catalog read readiness from durable completed-import evidence, never Library-row presence; partial initial pages already create rows, while completed disabled-provider data remains readable beside an incomplete enabled provider.
- Normalize omitted show and season runtime to zero duration during catalog import; Jellyfin omits runtime for non-playable hierarchy observations.
- When Jellyfin omits source or part runtime, inherit the playable item's runtime before emitting the plugin observation; never pass absent durations into the canonical non-null runtime fields.
- Treat exact-tag Jellyfin `MediaSourceInfo.Container` as comma-delimited format candidates inside the server extension; select a supported canonical container instead of comparing the raw internal value with the normalized catalog container.
- Clone exact-tag Jellyfin `MediaSourceInfo` values before `StreamBuilder` negotiation; the builder mutates its input, while Nama planning must remain side-effect-free across repeated calls.
- Derive exact-tag Jellyfin negotiated output codecs from `StreamInfo.AudioCodecs` and `VideoCodecs`; its `TargetAudioCodec` and `TargetVideoCodec` accessors return input codecs for `DirectStream`, including audio-remux plans that actually transcode.
- Validate Jellyfin stock media targets as root-relative strings instead of using `Uri.TryCreate(..., UriKind.Absolute)`; .NET classifies `/path` as an absolute file URI and would reject every safe in-process route.
- Contain unreadable provider credentials only after persistence identifies the affected instance; an unscoped installation-configuration recovery failure remains fail-closed and must not be treated as schema compatibility.
- Keep update-commit ambiguity state separate from retained delete-fence ownership; a non-delete mutation must fail while an ambiguous delete still owns the instance activity fence.
- On a Nama fatal setup-commit ambiguity, make local `GetStatus` fail `UNAVAILABLE/SETUP_UNAVAILABLE` until exit; never report `initialized=false`.
- While a Nama bootstrap attempt is active, return `SETUP_IN_PROGRESS` only for its matching token; every other candidate fails `AUTHENTICATION_FAILED`.
- Emit Nama `server.runtime_failed` at `fatal` severity so configured `warn`, `error`, and `fatal` thresholds retain it.
- Pass eligible non-loopback interface names to Ciao's responder as well as restricted addresses; on Darwin, an empty ARP table can leave autodetection with loopback only while `advertise()` still reports success.
- Join the LAN-advertisement fiber from its owning scope finalizer; Effect's built-in scoped-fiber finalizer ignores the child exit, which would otherwise turn responder-shutdown failure into successful process shutdown.
- Clone Jellyfin `UserItemData` before a coherent progress mutation; `GetUserData`
  returns a cached object, so changing it before `SaveUserData` can alter
  in-memory state before the transactional save or cancellation check.
- Convert every extension post-save progress readback failure to a retryable
  response so the plugin performs one ordinary readback; never emit a
  definitive 4xx result after a possible commit.

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
extensions/
  jellyfin/               # exact-versioned Jellyfin server extension
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
