# Remove Generated Contract Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove tests whose subject is generated contract code, retain real application compile coverage and handwritten policy tests, and align every normative Milestone 0 document with that boundary.

**Architecture:** Buf owns schema validation, breaking checks, and deterministic generation. The server, plugin, CLI, and tvOS builds prove generated clients are consumable; focused tests exist only for handwritten authorization, CEL, field-error normalization, and real transport adapters.

**Tech Stack:** Buf 1.72.0, Protobuf, Protobuf-ES 2.13.0, Connect-Go 1.20.0, SwiftProtobuf 1.38.1, Connect-Swift 1.2.3, Node.js 24, Go 1.26, Swift 6/Xcode 26.6, pnpm 11, mise.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-10-generated-contract-test-boundary-design.md` exactly.
- Do not add replacement generated-code tests, snapshots, fixtures, descriptor inventories, serialization round trips, or unknown-value preservation tests.
- Keep tests for handwritten authorization, the custom CEL rule, deterministic field-error normalization, and actual adapters.
- Keep Buf format/lint/build, deterministic staged generation comparison, and pull-request-base breaking checks.
- Keep compile probes in `apps/server/src/contract-probe.ts`, `plugins/jellyfin/src/contract-probe.ts`, `apps/cli/internal/cli/root.go`, and `apps/tvos/Nama/NamaApp.swift`.
- Keep `go test ./...` as the generic handwritten-test gate.
- Remove only dependencies and configuration used solely by the deleted harnesses; keep generated-client runtime dependencies.
- Do not change schemas, generated leaves, RPCs, messages, validation rules, or application behavior.
- The local machine lacks `/Applications/Xcode_26.6.app`; keep the tvOS build gate intact and report that local limitation accurately.
- Work in the approved main worktree and stop on unrelated changes.

---

### Task 1: Remove generated-binding tests and dedicated support

**Files:**

- Delete: `apps/server/src/contract.test.ts`
- Delete: `apps/cli/internal/cli/contracts_test.go`
- Delete: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Delete: `gen/swift/Package.resolved`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.oxlintrc.json`
- Modify: `go.mod`
- Modify: `go.sum`
- Modify: `gen/swift/Package.swift`
- Modify: `mise.toml`
- Modify: `.github/workflows/ci.yml`
- Verify unchanged: the four application compile probes listed in Global Constraints

**Interfaces:**

- Consumes: the current deterministic contract toolchain and generated SDK packages.
- Produces: unchanged SDK/application compile coverage without tests of generated behavior.

- [ ] **Step 1: Confirm the expected cleanup boundary**

Run:

```bash
git status --short
test -f apps/server/src/contract.test.ts
test -f apps/cli/internal/cli/contracts_test.go
test -f gen/swift/Tests/NamaAPITests/ContractTests.swift
test -f gen/swift/Package.resolved
```

Expected: only this approved plan may be uncommitted, and all four deletion targets exist.

- [ ] **Step 2: Delete only the generated-binding harnesses and standalone Swift lock**

Use `apply_patch` with these exact targets:

```diff
*** Begin Patch
*** Delete File: apps/server/src/contract.test.ts
*** Delete File: apps/cli/internal/cli/contracts_test.go
*** Delete File: gen/swift/Tests/NamaAPITests/ContractTests.swift
*** Delete File: gen/swift/Package.resolved
*** End Patch
```

Expected: no file under `gen/swift/Sources/NamaAPI` changes.

- [ ] **Step 3: Remove TypeScript support owned only by the deleted test**

Apply these exact end states:

- `apps/server/package.json`: remove `check:contract` and the complete `devDependencies` block; keep `check:type` and `@nama/api`.
- `apps/server/tsconfig.json`: remove `"types": ["node"]`; keep `rootDir` and the existing include.
- root `package.json`: set `check:ts` to `pnpm run check:format && pnpm run check:lint && pnpm run check:type`.
- `.oxlintrc.json`: remove `import/no-nodejs-modules` and `eslint/no-duplicate-imports`; set `eslint/sort-imports` to `"warn"`.

Expected: the server compiles only its application probe and no Node test runner is configured.

- [ ] **Step 4: Remove native dependencies and targets owned only by deleted tests**

Apply these exact changes:

- remove direct `google.golang.org/genproto/googleapis/rpc v0.0.0-20260810153831-ec0a7760b754` from `go.mod`;
- remove only the `.testTarget(name: "NamaAPITests", ...)` block from `gen/swift/Package.swift`;
- keep the `NamaAPI` library target and its Connect/SwiftProtobuf products unchanged.

Expected: generated Go still owns Protovalidate, Connect, and Protobuf runtimes; tvOS still consumes the local `NamaAPI` library.

- [ ] **Step 5: Remove standalone Swift-test wiring from local tasks**

In `mise.toml`:

- delete `swift package resolve --package-path gen/swift` from `setup`;
- make setup's Swift lock check reference only `apps/tvos/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`;
- remove `gen/swift/Tests` from `format` and `check:swift`;
- remove `swift test --package-path gen/swift`;
- make `check:swift` snapshot and compare only the Xcode workspace lock; and
- keep the existing tvOS simulator `xcodebuild` command unchanged.

Keep `check:go`, including `go test ./...`, unchanged.

- [ ] **Step 6: Remove standalone Swift-test wiring from CI**

In `.github/workflows/ci.yml`:

- delete the `Test generated Swift package` step;
- remove `gen/swift/Tests` from `Check Swift formatting`;
- remove `gen/swift/Package.resolved` from both Swift lock-drift commands; and
- keep `Build tvOS simulator target`, Linux contract/TypeScript/Go checks, and the complete `buf-breaking` job unchanged.

- [ ] **Step 7: Recompute dependency locks from the cleaned manifests**

Run:

```bash
pnpm install --lockfile-only
go mod tidy
```

Expected: the server lock importer contains only `@nama/api`; `@types/node` and `undici-types` disappear; `@bufbuild/protobuf` remains for `gen/ts`; and the Google RPC Go module disappears without removing other direct runtime dependencies.

- [ ] **Step 8: Verify removal and retained application compilation**

Run:

```bash
set -eu
test ! -e apps/server/src/contract.test.ts
test ! -e apps/cli/internal/cli/contracts_test.go
test ! -e gen/swift/Tests
test ! -e gen/swift/Package.resolved
if rg -n '"check:contract"|node:test|node:assert/strict|NamaAPITests|gen/swift/Tests|gen/swift/Package.resolved|swift test --package-path gen/swift' package.json apps/server .oxlintrc.json gen/swift/Package.swift mise.toml .github/workflows/ci.yml; then exit 1; else test "$?" -eq 1; fi
if rg -n 'google.golang.org/genproto/googleapis/rpc' go.mod go.sum; then exit 1; else test "$?" -eq 1; fi
rg -n 'HealthService' apps/server/src/contract-probe.ts plugins/jellyfin/src/contract-probe.ts apps/cli/internal/cli/root.go apps/tvos/Nama/NamaApp.swift
mise run check:contracts
mise run check:ts
mise run check:go
git diff --check
```

Expected: searches for removed support have no matches, all four probes match, and every locally supported gate passes.

- [ ] **Step 9: Commit the infrastructure cleanup**

```bash
git add .github/workflows/ci.yml .oxlintrc.json apps/server/package.json apps/server/tsconfig.json gen/swift/Package.swift go.mod go.sum mise.toml package.json pnpm-lock.yaml
git add -u -- apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Tests gen/swift/Package.resolved
git commit -m "test(api): remove generated contract tests"
```

### Task 2: Reconcile normative documents and run the final gate

**Files:**

- Modify: `docs/architecture/api-contracts.md`
- Modify: `docs/superpowers/plans/2026-08-10-milestone-0-contract-toolchain.md`
- Modify: `docs/superpowers/plans/2026-08-10-milestone-0-public-management-contracts.md`
- Modify: `docs/superpowers/plans/2026-08-10-milestone-0-public-media-playback-contracts.md`
- Modify: `docs/superpowers/plans/2026-08-10-milestone-0-plugin-contracts-and-conformance.md`
- Verify: every file changed or retained by Task 1

**Interfaces:**

- Consumes: the approved boundary and Task 1's cleaned repository surface.
- Produces: plans that accept generated contracts through Buf/application compilation and reserve tests for handwritten Nama behavior.

- [ ] **Step 1: Replace the canonical generated-test policy**

In `docs/architecture/api-contracts.md`, keep the seven repository checks under `## Generation and verification`, then replace the paragraph beginning `Contract tests inspect descriptors` and its list with:

```markdown
Nama does not test generated Protobuf or Connect behavior. Buf and the pinned language generators/runtimes own serialization, descriptor construction, unknown-value preservation, and generated API shape. Generated-contract acceptance consists of schema format/lint/build, deterministic generated-leaf comparison, pull-request-base breaking checks, and compilation by the real TypeScript server/plugin, Go CLI, and tvOS applications.

Focused contract tests cover handwritten Nama behavior only:

- every generated RPC method appears exactly once in the handwritten default-deny authorization inventory;
- the package-local `PlaybackPreferences` CEL rule executes for valid and invalid CAPPED bit-rate combinations;
- validation inputs normalize to deterministic, capped per-field errors with stable paths and reasons; and
- adapters translate generated transport values into Nama-owned values without leaking provider-private data.

Generated values or descriptors may be inputs to those tests, but serialization round trips, generated symbol inventories, descriptor snapshots, unknown enum/oneof/field preservation, and cross-language parity are not test subjects.
```

Keep the following handler-conformance paragraph unchanged.

- [ ] **Step 2: Rewrite Plan 1 to use real application compile probes**

In `2026-08-10-milestone-0-contract-toolchain.md`:

- change the Goal to deterministic dependency, generation, validation, and real-application compile foundations;
- replace descriptor/round-trip scope with schemas, generated SDKs, application probes, and later handwritten-policy tests;
- replace Task 3 with four checks: `rg` for `HealthService` in all four application probes, `mise run check:ts`, `mise run check:go`, and `mise run check:swift` with the pinned-Xcode limitation;
- delete every harness file/dependency/Swift target/lock/task/CI instruction and commit path from the plan; and
- retain Tasks 1, 2, and 4's schema pins, atomic generation, Buf gates, generated-leaf comparisons, and breaking job unchanged.

Expected: Plan 1 contains no generated fixture or standalone Swift package test.

- [ ] **Step 3: Rewrite Plan 2 schema tasks and retain only authorization testing**

In `2026-08-10-milestone-0-public-management-contracts.md`:

- remove the three generated harness paths and every round-trip/red-check step from Tasks 1–5;
- retain each schema declaration, `mise run generate`, `check:contracts`, language application checks, boundary search, and commit;
- keep Task 6's handwritten default-deny authorization inventory test;
- introduce the first handwritten test infrastructure in Task 6: exact `@types/node@24.13.3` and `@bufbuild/protobuf@2.13.0` server dev dependencies, `node --test src/contract.test.ts`, the root `check:ts` call, Node compiler types, and only the Node-test/import-sort lint allowances;
- make generated method descriptors inputs to the authorization comparison, not independent presence assertions; and
- state that CLI/tvOS retain Health application probes and no Go/Swift contract test exists.

Expected: Tasks 1–5 prove schemas through Buf and real builds; Task 6 tests only handwritten authorization policy.

- [ ] **Step 4: Rewrite Plan 3 schema tasks and retain only authorization testing**

In `2026-08-10-milestone-0-public-media-playback-contracts.md`:

- remove all generated fixture paths and round-trip/red-check steps from Tasks 1–4;
- retain schema declarations, deterministic generation, application checks, source-level public-boundary search, and commits;
- keep only authorization-map completeness and the server compile probe in Task 5; and
- delete `BadRequest` serialization, unknown enum/oneof behavior, generated expiry-field, and descriptor-name assertions.

Use the existing completion-gate `rg` over `proto/nama/api` as the provider-private boundary check. Expected: no representative-message harness remains.

- [ ] **Step 5: Rewrite Plan 4 around handwritten CEL and error normalization**

In `2026-08-10-milestone-0-plugin-contracts-and-conformance.md`:

- remove round-trip fixture steps from Tasks 1–4 while retaining schemas, generation, TypeScript application compilation, and package-isolation source searches;
- remove Go/Swift harness paths, exact RPC-count assertions, descriptor snapshots, representative message fixtures, unknown enum/oneof checks, and generated `BadRequest` round trips from Task 5;
- keep authorization-map completeness and the seven existing CAPPED bit-rate cases against both package-local schemas using one Protovalidate validator, without serialization;
- replace the field-error round trip with `apps/server/src/contract-errors.ts` exposing `normalizeContractFieldErrors(violations: readonly ContractFieldErrorInput[]): ContractFieldError[]`;
- define both error types with only `field`, `reason`, `description`, and optional `{ locale, message }`; sort by field/reason/description using code-unit comparisons, copy only those fields, and cap output at 50;
- test that handwritten normalizer with the six approved violations supplied in reverse order plus a 51-entry cap case;
- keep adapter tests only when an actual handwritten adapter's mapping, filtering, redaction, or fallback is the subject; and
- keep documentation reconciliation, reviewed source searches, complete repository gates, the deliberate `buf breaking` proof, and deterministic regeneration.

Replace the completion claims about descriptor counts and cross-language round trips with authorization completeness, real application compilation, the CEL test, and the field-error normalizer test.

- [ ] **Step 6: Prove the four plans cannot recreate generated tests**

Run:

```bash
set -eu
plans='docs/superpowers/plans/2026-08-10-milestone-0-contract-toolchain.md docs/superpowers/plans/2026-08-10-milestone-0-public-management-contracts.md docs/superpowers/plans/2026-08-10-milestone-0-public-media-playback-contracts.md docs/superpowers/plans/2026-08-10-milestone-0-plugin-contracts-and-conformance.md'
if rg -n 'apps/cli/internal/cli/contracts_test\.go|gen/swift/Tests|gen/swift/Package\.resolved|swift test --package-path gen/swift' $plans; then exit 1; else test "$?" -eq 1; fi
if rg -n '^- \[ \].*(round.?trip|unknown (enum|oneof|field)|descriptor (package|symbol|reservation))' $plans; then exit 1; else test "$?" -eq 1; fi
git diff --check -- docs/architecture/api-contracts.md $plans
```

Expected: no generated-harness path or generated-behavior test step remains. `apps/server/src/contract.test.ts` appears only for handwritten authorization, CEL, normalization, or real adapter behavior.

- [ ] **Step 7: Run retained repository gates and inspect scope**

Run:

```bash
set -eu
pnpm install --frozen-lockfile
go mod download
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:docker
git diff --check
git diff --exit-code 4196a29 -- proto gen/ts/src gen/go gen/swift/Sources/NamaAPI
rg -n 'buf breaking proto|Build tvOS simulator target' .github/workflows/ci.yml
if test -d /Applications/Xcode_26.6.app; then mise run check:swift; else printf '%s\n' 'Xcode 26.6 unavailable locally; unchanged tvOS gate must pass in macOS CI'; fi
git status --short
```

Expected: local gates pass, schemas/generated leaves are unchanged from `4196a29`, retained CI gates are present, and the current machine reports—not conceals—the Xcode limitation.

- [ ] **Step 8: Commit the normative reconciliation**

```bash
git add docs/architecture/api-contracts.md docs/superpowers/plans/2026-08-10-milestone-0-contract-toolchain.md docs/superpowers/plans/2026-08-10-milestone-0-public-management-contracts.md docs/superpowers/plans/2026-08-10-milestone-0-public-media-playback-contracts.md docs/superpowers/plans/2026-08-10-milestone-0-plugin-contracts-and-conformance.md
git commit -m "docs(api): align generated-test boundary"
```

## Completion Gate

- Generated-binding tests, their dedicated dependencies, Swift target/lock, task wiring, and CI step are absent.
- Buf format/lint/build, deterministic drift, breaking checks, and all four application probes remain.
- All four Milestone 0 plans accept generated code through those gates and reserve tests for handwritten behavior.
- Supported local checks pass; the unchanged tvOS build passes on Xcode 26.6/macOS CI.
