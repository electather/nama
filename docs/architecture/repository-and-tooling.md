# Repository and tooling

Status: approved on 2026-08-09.

## Purpose

This specification defines the repository and tooling portion of Milestone 0: a buildable polyglot workspace, deterministic contract generation, native checks, GitHub Actions, and publication of the public `github.com/electather/nama` repository under AGPL-3.0.

It establishes every deployable boundary but adds no product behavior. The remaining `api.v1` and `plugin.v1` contract semantics receive a separate design before Milestone 0 is complete.

## Accepted architecture refinement

Mise replaces the previously optional root Makefile. It pins command-line tools and provides discoverable root tasks, while each task delegates directly to the owning ecosystem. Mise does not model a build graph, cache outputs, replace native manifests, or make one language depend on another language's package manager.

This keeps the architecture's prohibition on a universal build framework while avoiding two overlapping root command surfaces.

## Scope

The baseline includes:

- a Git repository on `main` and a public GitHub repository at `electather/nama`;
- an AGPL-3.0 license, concise README, editor settings, and language-aware ignore rules;
- pinned Node.js 24, pnpm, Go 1.26, and Buf tools through mise;
- pnpm, Go, Swift/Xcode, Buf, and Docker native manifests;
- compilable server, CLI, tvOS, and Jellyfin plugin boundaries;
- one real public Health contract and one real plugin Health contract;
- committed TypeScript, Go, and Swift generated code;
- root generation and check tasks; and
- GitHub Actions checks for Linux, macOS/tvOS, and Protobuf compatibility.

The baseline excludes server behavior, database access, authentication, provider calls, media models, playback, synchronization, deployment images, releases, dependency bots, coverage services, and branch-protection policy.

## Repository layout

```text
.
├── .github/workflows/ci.yml
├── apps/
│   ├── cli/
│   │   ├── cmd/nama/
│   │   └── internal/cli/
│   ├── server/
│   └── tvos/
├── gen/
│   ├── go/nama/api/v1/
│   ├── swift/
│   │   ├── Package.swift
│   │   └── Sources/NamaAPI/
│   └── ts/
│       ├── package.json
│       └── src/
├── plugins/jellyfin/
├── proto/nama/
│   ├── api/v1/
│   └── plugin/v1/
├── docs/
├── buf.gen.yaml
├── buf.yaml
├── compose.yaml
├── go.mod
├── mise.lock
├── mise.toml
├── package.json
└── pnpm-workspace.yaml
```

`apps/server` and `plugins/jellyfin` are separate strict-TypeScript ESM packages. `apps/cli` is a Cobra executable within the root Go module `github.com/electather/nama`: `cmd/nama/main.go` is its composition root and `internal/cli/root.go` owns the minimal command tree. This baseline creates no management behavior or speculative CLI packages. `apps/tvos` is a checked-in, minimal SwiftUI Xcode project targeting tvOS 17 or later. It has a runnable app target but no product screens or networking behavior.

Generated code is isolated under `gen`, but only generated-only leaves are Buf outputs. `gen/ts` is a pnpm workspace package whose generated files live under `gen/ts/src`. `gen/go` is entirely generated and belongs to the root Go module. `gen/swift` is a local Swift package whose generated files live under `gen/swift/Sources/NamaAPI`. Package manifests remain outside directories that Buf cleans. Handwritten application code never lives in generated-only leaves.

## Tool ownership

`mise.toml` sets a hard minimum of mise 2026.8.3 and records exact compatible releases of Node.js 24, pnpm, Go 1.26, and Buf. The generated `mise.lock` is committed. GitHub Actions installs mise 2026.8.3 explicitly; developers may use a newer compatible mise. Xcode and Docker remain documented platform prerequisites because mise cannot supply the supported Apple SDK or Docker runtime.

Native files remain authoritative:

- `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` own Node packages and exact JavaScript dependencies;
- Oxfmt and Oxlint own handwritten TypeScript and JSON formatting and linting; `tsc --noEmit` remains the TypeScript type check;
- `go.mod` and `go.sum` own Go and Cobra dependencies;
- the checked-in Xcode project, `gen/swift/Package.swift`, and `apps/tvos/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` own tvOS and Swift dependencies;
- Buf module, lint, and generation files own Protobuf. `buf.lock` is generated and committed only when `buf.yaml` first declares an external schema dependency. This dependency-free baseline contains neither a hand-written empty lock nor a fake dependency; and
- `compose.yaml` owns the PostgreSQL 18 development service.

The implementation chooses exact patch releases that satisfy the accepted architecture and records them in configuration and lockfiles. Those patches are implementation data, not long-term promises in this design.

Vitest and `@effect/vitest` remain required by the approved server foundation but enter in Milestone 2, when there is behavior to test. This compile-only baseline does not add an empty test runner or fake tests.

## Root tasks

The public command surface is:

- `mise install`: install the pinned command-line tools;
- `mise run setup`: resolve pnpm, Go, and Swift dependencies using committed lock state;
- `mise run generate`: generate all supported clients from the committed schemas;
- `mise run format`: format handwritten TypeScript/JSON with Oxfmt, Go with `gofmt`, and Swift with the built-in `swift format`;
- `mise run check`: run every repository check on a fully provisioned Mac;
- `mise run check:contracts`: lint schemas, regenerate clients, and assert that generated output is unchanged;
- `mise run check:ts`: run `oxfmt --check`, Oxlint, and `tsc --noEmit` over handwritten TypeScript/JSON; generated TypeScript source remains out of scope while `gen/ts/package.json` is included;
- `mise run check:go`: check formatting, run `go vet`, and run `go test`;
- `mise run check:swift`: strictly lint handwritten Swift with the built-in `swift format`, then build the tvOS simulator target with code signing disabled; generated Swift under `gen/swift/Sources` remains excluded because Buf owns it; and
- `mise run check:docker`: validate the Compose model.

On a fully provisioned Mac, fresh-checkout bootstrap is exactly `mise install`, then `mise run setup`, then `mise run check`. Setup delegates to `pnpm install --frozen-lockfile`, `go mod download`, and Xcode package resolution with `-onlyUsePackageVersionsFromResolvedFile`. It neither updates nor creates lock state.

The aggregate `check` task is a sequential mise `run` array of task references, not a set of `depends`. It stops on the first failed native command and returns its non-zero status. It does not reinterpret failures, run checks concurrently, or silently skip an unavailable prerequisite.

## Contract generation

The representative public contract is `nama.api.v1.HealthService.Check`. The representative plugin contract is `nama.plugin.v1.HealthService.Check`. Each uses an empty request and a package-local response containing a provider-neutral serving-status enum. These stable, additive shapes exercise both boundaries without pre-designing setup, media, playback, or synchronization APIs.

Buf v2 uses `clean: true`, but every plugin output points only to `gen/ts/src`, `gen/go`, or `gen/swift/Sources/NamaAPI`; package manifests cannot be deleted. Every official Protobuf and Connect remote plugin specifies both its upstream version and BSR revision. Buf generates only code with a present consumer:

```text
api.v1 health ─────┬──> gen/ts/src
                   ├──> gen/go/nama/api/v1
                   └──> gen/swift/Sources/NamaAPI

plugin.v1 health ─────> gen/ts/src
```

Buf managed mode sets `go_package_prefix` to `github.com/electather/nama/gen/go` and Go generators use source-relative output. The public Health client therefore has the exact import path `github.com/electather/nama/gen/go/nama/api/v1`.

`gen/swift/Package.swift` exports one `NamaAPI` library target with direct `Connect` and `SwiftProtobuf` product dependencies. Both Swift generators use `Visibility=Public`. The tvOS compile probe references the generated Health service client interface type, rather than merely importing the module.

The server compile target imports both TypeScript namespaces. The Jellyfin compile target imports only `plugin.v1`. The CLI's root command references the public Go Health client type from the declared import path. The tvOS app references the public Swift Health client type.

Generated output is committed. Clean generation removes obsolete output before recreating it; afterward the contract check examines tracked changes and untracked files under `gen`, and either condition fails. Developers change schemas and generator configuration, run generation, and commit schemas and outputs together.

## Docker baseline

`compose.yaml` defines PostgreSQL 18 with a health check and development-only persistent storage. No server or plugin image exists yet because neither executable has runtime behavior. The baseline validates the Compose model but does not start PostgreSQL as part of routine checks.

The production application image remains Milestone 3 work, when the server and bundled plugin executable exist.

## GitHub Actions

One workflow runs on pushes to `main` and on pull requests. Actions are pinned and receive read-only repository permissions. No repository or deployment secrets are required.

The workflow contains three jobs:

1. **Linux:** check out full Git history, install mise 2026.8.3 and its pinned tools, install pnpm dependencies from the frozen lockfile, run contract generation and cleanliness checks, run TypeScript and Go checks, and validate Compose.
2. **tvOS:** use the explicit `macos-26` runner and `/Applications/Xcode_26.6.app`, resolve only versions from the committed workspace `Package.resolved`, build the Apple TV simulator scheme without signing, and fail if package resolution changes the lockfile.
3. **Buf breaking:** on pull requests, fetch the base ref explicitly and compare `proto/` against that ref with `subdir=proto`. The initial `main` push runs lint and generation checks but has no prior branch to compare.

At design approval, the development machine has Swift command-line tools but not full Xcode. Before the first push, every locally available check must pass. The macOS GitHub Actions job is the authoritative initial tvOS verification; once Xcode is installed locally, `mise run check` covers the complete repository. Changes to the pinned runner or Xcode pair are deliberate compatibility upgrades.

As a one-time Milestone 0 acceptance check after the baseline commit but before its first push, implementation builds an unbroken Buf image from local `HEAD`. It then copies the root Buf configuration and `proto/` into a disposable workspace, removes the committed `Check` method there, and verifies that the repository's breaking rules exit non-zero when comparing the broken temporary module with the unbroken image. The disposable workspace and image are then discarded. This proves the gate without retaining a deliberately broken fixture or modifying the working tree.

## Repository publication

The approved documentation is already committed to local `main`. Implementation runs every locally available routine check, commits the baseline, performs the one-time deliberate breaking proof against that commit, creates the public `electather/nama` repository, and pushes `main`. tvOS completion remains pending until the initial macOS job succeeds. If the remote repository already exists, implementation stops and inspects it instead of overwriting or force-pushing.

Publication is complete only after the initial GitHub Actions run passes. No release, package publication, deployment, or branch-protection configuration accompanies the initial push.

## Error handling

- Missing native prerequisites fail with their native diagnostic and the README identifies the required setup.
- Tool installation, dependency resolution, generation, compilation, formatting, and validation failures return non-zero without fallback behavior.
- Generated-code drift includes both modified tracked files and new untracked files.
- Dependency setup and CI use committed pnpm, Go, mise, and Swift lock state and fail rather than update it.
- CI does not write generated fixes back to branches.
- No check prints or requires credentials.
- Repository creation never replaces an existing remote or rewrites its history.

## Verification and completion criteria

The baseline is complete when:

1. a fresh checkout on a fully provisioned Mac completes `mise install`, `mise run setup`, and `mise run check` without changing lockfiles;
2. `mise run generate` deterministically recreates all committed clients;
3. server, Jellyfin plugin, Go CLI, and tvOS app compile against the intended generated packages;
4. Oxfmt formatting, Oxlint, and TypeScript type checks pass;
5. `gofmt`, Go vet, and Go tests pass;
6. built-in `swift format` lint passes and the tvOS 17-or-later simulator target builds without signing;
7. Compose validates the PostgreSQL 18 development service;
8. regeneration leaves no tracked or untracked change under `gen`;
9. a disposable deliberate `v1` method removal makes `buf breaking` fail;
10. the public GitHub repository exists at `github.com/electather/nama`; and
11. every GitHub Actions job applicable to the initial push succeeds without changing dependency lock state; the pull-request-only breaking job may be skipped.

Compile checks are sufficient for the empty application boundaries. Runtime integration tests begin with the milestone that introduces behavior; this baseline does not invent fake runtime behavior merely to test it.

## Follow-up

The next design in Milestone 0 defines the remaining `api.v1` and `plugin.v1` services, messages, validation rules, errors, and compatibility policy. Server foundation implementation remains Milestone 2 work governed by the approved core-server design.
