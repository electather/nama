# Repository and tooling

## Purpose and boundary

This note records the repository architecture: one polyglot workspace,
deterministic contract generation, native verification, and CI. TypeScript,
Go, Swift, Protobuf, plugin, and deployment surfaces remain in the same
repository while their native configurations own their respective concerns.
Contract boundary rules and compatibility policy live in
[API contracts](api-contracts.md); the Protobuf schemas own concrete service
and message definitions.

## Orchestration and ownership

Mise is the thin root orchestrator
([ADR-0017](../adr/0017-mise-thin-native-orchestrator.md)). It exposes
discoverable repository tasks and delegates to the tool that owns each concern;
it is not a universal build graph, cache, or replacement for native manifests.

Native configuration is the source of truth:

- JavaScript workspace manifests, lockfiles, and TypeScript quality
  configuration own Node packages and checks.
- Server-local Fallow configuration owns graph-oriented checks for handwritten
  server TypeScript; Oxlint and TypeScript remain the lint and type owners.
- The root pre-commit configuration owns portable hooks, executed by the
  Mise-pinned prek binary. Path-scoped hooks do not replace aggregate repository
  verification.
- The Go module owns Go dependencies; native Go tools own its checks.
- The committed universal Xcode project owns the Apple application and test
  targets, its Swift package resolution, and native platform builds. The
  committed Swift package manifest owns generated Swift binding dependencies.
- Buf module and generation configuration own Protobuf validation and
  generation.
- Compose owns the local database service model.
- The exact-versioned Jellyfin extension project manifest, its MSTest project,
  committed NuGet locks, and nested EditorConfig own native .NET dependencies,
  tests, SDK/Meziantou analysis, and C# style enforcement.

This architecture note deliberately does not duplicate their versions, flags,
commands, paths, or CI job implementation.

## Generated contracts

Schemas and generator configuration are edited; generated leaves are not.
Generated code is committed so present consumers compile from the same contract
revision, and a schema or generator change moves with its regenerated output
([ADR-0018](../adr/0018-commit-present-consumer-bindings.md)). No application
code or package manifest belongs inside a Buf-cleaned leaf.

Generation remains consumer-driven: generate only the bindings used by a
present consumer. Public API contracts and plugin contracts remain distinct
boundaries; consumers depend on only the boundary they need.

## Change and verification workflow

Mise exposes the root task surface. Multi-step Bash task implementations live
in `scripts/` and are invoked by thin Mise task definitions; the scripts do
not add tasks or change native-tool ownership. Use `mise tasks` to inspect the
current surface, then inspect the owning native manifest or configuration. This
note is not a command reference.

Before changing a dependency, generator, or check, inspect its owning manifest
and use that ecosystem's native tool to update its dependencies and lock state.
Run the narrow native check first, then use the aggregate repository check on a
fully provisioned Mac. Its declared Mise dependency graph starts independent
native owners concurrently and respects Mise's standard job limit; native tasks
remain independently runnable.

`mise run check:jellyfin-extension` is the independently runnable native .NET
owner. Its script forces the pinned SDK container to Linux AMD64, restores both
dependency graphs in locked mode, verifies formatting, runs the Release MSTest
application through Microsoft Testing Platform, requires analyzer-clean Release
compilation, packages the exact Jellyfin artifact, and prepares the
fault-injected server-test fixture. TypeScript server-test setup consumes this
owner rather than duplicating or narrowing it.

Docker and Xcode are current native prerequisites. The universal Xcode project
imports the generated public package, and `check:swift` owns formatting, lint,
macOS tests, signing-disabled generic iOS, tvOS, and macOS builds, transport and
entitlement validation, dependency-lock drift, and analyzer lint. Generated
bindings and compile-only builds do not prove application runtime behavior.

CI runs the native checks and the contract-compatibility gate appropriate to
the change. Compile-only boundaries prove compilation, not product or runtime
behavior.

Pull-request correctness starts Contracts, TypeScript, Go, Packaged Application,
and Swift as independent jobs. The TypeScript job installs Go only because its
server-runtime suite builds the public CLI; native Go checks remain owned by the
Go job. Vitest, Go, and Xcode publish compact normalized test-health reports
without raw logs or result bundles. A separate weekly and manual workflow
repeats each ecosystem suite three times and rejects failed or inconsistent
outcomes.

## Agent guardrails

- Do not invent dependencies, lockfiles, tests, or generated output to make a
  boundary appear complete.
- Do not hand-edit generated code or add speculative root wrappers.
- Do not silently update lock state; changes to it are deliberate, reviewed
  dependency changes.
- Do not infer runtime or product behavior from a compile-only boundary.
