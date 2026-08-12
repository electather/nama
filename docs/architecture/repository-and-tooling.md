# Repository and tooling

## Purpose and boundary

This note records the Milestone 0 repository decisions: a buildable polyglot
workspace, deterministic contract generation, native verification, and CI. It
establishes tooling and deployable boundaries only. Contract boundary rules and
compatibility policy live in [API contracts](api-contracts.md); the Protobuf
schemas own concrete service and message definitions. Server runtime behavior
is later work.

## Orchestration and ownership

Mise is the thin root orchestrator. It exposes discoverable repository tasks
and delegates to the tool that owns each concern; it is not a universal build
graph, cache, or replacement for native manifests.

Native configuration is the source of truth:

- JavaScript workspace manifests, lockfiles, and TypeScript quality
  configuration own Node packages and checks.
- The Go module owns Go dependencies; native Go tools own its checks.
- The checked-in Xcode project, Swift package manifest, and resolved-package
  state own the tvOS application and Swift dependencies.
- Buf module and generation configuration own Protobuf validation and
  generation.
- Compose owns the local database service model.

This architecture note deliberately does not duplicate their versions, flags,
commands, paths, or CI job implementation.

## Generated contracts

Schemas and generator configuration are edited; generated leaves are not.
Generated code is committed so consumers compile from the same contract
revision, but no application code or package manifest belongs inside a
Buf-cleaned leaf. A schema or generator change and its regenerated output move
together.

Generation is consumer-driven: generate only the bindings used by a present
consumer. Public API contracts and plugin contracts remain distinct boundaries;
consumers depend on only the boundary they need.

## Change and verification workflow

Mise exposes the root task surface. Multi-step Bash task implementations live
in `scripts/` and are invoked by thin Mise task definitions; the scripts do
not add tasks or change native-tool ownership. Use `mise tasks` to inspect the
current surface, then inspect the owning native manifest or configuration. This
note is not a command reference.

Before changing a dependency, generator, or check, inspect its owning manifest
and use that ecosystem's native tool to update its dependencies and lock state.
Run the narrow native check first, then the aggregate repository check on a
fully provisioned Mac. Root tasks coordinate this sequence but do not alter
its ownership.

Xcode and Docker are native prerequisites. When the pinned Xcode is unavailable
locally, hosted macOS CI is authoritative for the Apple check. A machine
limitation never justifies weakening or skipping a required check.

CI runs the native checks and the contract-compatibility gate appropriate to
the change. Compile-only boundaries prove compilation, not product or runtime
behavior.

## Agent guardrails

- Do not invent dependencies, lockfiles, tests, or generated output to make a
  boundary appear complete.
- Do not hand-edit generated code or add speculative root wrappers.
- Do not silently update lock state; changes to it are deliberate, reviewed
  dependency changes.
- Do not infer runtime or product behavior from a compile-only boundary.
