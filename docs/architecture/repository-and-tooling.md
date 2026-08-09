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
- compileable server, CLI, tvOS, and Jellyfin plugin boundaries;
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
│   ├── server/
│   └── tvos/
├── gen/
│   ├── go/
│   ├── swift/
│   └── ts/
├── plugins/jellyfin/
├── proto/nama/
│   ├── api/v1/
│   └── plugin/v1/
├── docs/
├── compose.yaml
├── go.mod
├── mise.toml
├── package.json
└── pnpm-workspace.yaml
```

`apps/server` and `plugins/jellyfin` are separate strict-TypeScript ESM packages. `apps/cli` is a Cobra executable within the root Go module `github.com/electather/nama`. `apps/tvos` is a checked-in, minimal SwiftUI Xcode project targeting tvOS 17 or later. It has a runnable app target but no product screens or networking behavior.

Generated code is isolated under `gen`. `gen/ts` is a pnpm workspace package shared by the server and Jellyfin plugin. `gen/go` belongs to the root Go module. `gen/swift` is a local Swift package consumed by the tvOS project. Handwritten application code never lives in generated directories.

## Tool ownership

`mise.toml` records exact compatible releases of Node.js 24, pnpm, Go 1.26, and Buf. Xcode and Docker remain documented platform prerequisites because mise cannot supply the supported Apple SDK or Docker runtime.

Native files remain authoritative:

- `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` own Node packages and exact JavaScript dependencies;
- strict TypeScript configuration, Biome, Vitest, and `@effect/vitest` own TypeScript compilation and checks;
- `go.mod` and `go.sum` own Go and Cobra dependencies;
- the checked-in Xcode project, Swift package manifest, and resolved package state own tvOS and Swift dependencies;
- Buf module, lint, generation, and lock files own Protobuf; and
- `compose.yaml` owns the PostgreSQL 18 development service.

The implementation chooses exact patch releases that satisfy the accepted architecture and records them in configuration and lockfiles. Those patches are implementation data, not long-term promises in this design.

## Root tasks

The public command surface is:

- `mise install`: install the pinned command-line tools;
- `mise run generate`: generate all supported clients from the committed schemas;
- `mise run check`: run every repository check on a fully provisioned Mac;
- `mise run check:contracts`: lint schemas, regenerate clients, and assert that generated output is unchanged;
- `mise run check:ts`: run Biome, TypeScript, and Vitest checks;
- `mise run check:go`: check formatting, run `go vet`, and run `go test`;
- `mise run check:swift`: build the tvOS simulator target with code signing disabled; and
- `mise run check:docker`: validate the Compose model.

The aggregate task stops on the first failed native command and returns its non-zero status. It does not reinterpret failures or silently skip an unavailable prerequisite.

## Contract generation

The representative public contract is `nama.api.v1.HealthService.Check`. The representative plugin contract is `nama.plugin.v1.HealthService.Check`. Each uses an empty request and a package-local response containing a provider-neutral serving-status enum. These stable, additive shapes exercise both boundaries without pre-designing setup, media, playback, or synchronization APIs.

Buf uses pinned official Protobuf and Connect generators. It generates only code with a present consumer:

```text
api.v1 health ─────┬──> gen/ts
                   ├──> gen/go
                   └──> gen/swift

plugin.v1 health ─────> gen/ts
```

The server compile target imports both TypeScript namespaces. The Jellyfin compile target imports only `plugin.v1`. The CLI imports the public Go Connect client. The tvOS app imports the public Swift client.

Generated output is committed. After generation, the contract check examines tracked changes and untracked files under `gen`; either condition fails the check. Developers change schemas and generator configuration, run generation, and commit schemas and outputs together.

## Docker baseline

`compose.yaml` defines PostgreSQL 18 with a health check and development-only persistent storage. No server or plugin image exists yet because neither executable has runtime behavior. The baseline validates the Compose model but does not start PostgreSQL as part of routine checks.

The production application image remains Milestone 3 work, when the server and bundled plugin executable exist.

## GitHub Actions

One workflow runs on pushes to `main` and on pull requests. Actions are pinned and receive read-only repository permissions. No repository or deployment secrets are required.

The workflow contains three jobs:

1. **Linux:** install pinned mise tools, install pnpm dependencies from the frozen lockfile, run contract generation and cleanliness checks, run TypeScript and Go checks, and validate Compose.
2. **tvOS:** select the declared Xcode release on a macOS runner, resolve locked Swift dependencies, and build the Apple TV simulator scheme without signing.
3. **Buf breaking:** on pull requests, compare `proto/` with the pull request's base branch. The initial `main` push runs lint and generation checks but has no prior branch to compare.

The current development machine has Swift command-line tools but not full Xcode. Before the first push, every locally available check must pass. The macOS GitHub Actions job is the authoritative initial tvOS verification; once Xcode is installed locally, `mise run check` covers the complete repository.

## Repository publication

The approved documentation is already committed to local `main`. Implementation commits the locally verified baseline on top, creates the public `electather/nama` repository, and pushes `main`. If that remote repository already exists, implementation stops and inspects it instead of overwriting or force-pushing.

Publication is complete only after the initial GitHub Actions run passes. No release, package publication, deployment, or branch-protection configuration accompanies the initial push.

## Error handling

- Missing native prerequisites fail with their native diagnostic and the README identifies the required setup.
- Tool installation, dependency resolution, generation, compilation, formatting, and validation failures return non-zero without fallback behavior.
- Generated-code drift includes both modified tracked files and new untracked files.
- CI does not write generated fixes back to branches.
- No check prints or requires credentials.
- Repository creation never replaces an existing remote or rewrites its history.

## Verification and completion criteria

The baseline is complete when:

1. a fresh checkout can install pinned command-line tools with `mise install`;
2. `mise run generate` deterministically recreates all committed clients;
3. server, Jellyfin plugin, Go CLI, and tvOS app compile against the intended generated packages;
4. TypeScript formatting, type checks, and tests pass;
5. Go formatting, vet, and tests pass;
6. the tvOS 17-or-later simulator target builds without signing;
7. Compose validates the PostgreSQL 18 development service;
8. regeneration leaves no tracked or untracked change under `gen`;
9. the public GitHub repository exists at `github.com/electather/nama`; and
10. every initial GitHub Actions job passes.

Compile checks are sufficient for the empty application boundaries. Runtime integration tests begin with the milestone that introduces behavior; this baseline does not invent fake runtime behavior merely to test it.

## Follow-up

The next design in Milestone 0 defines the remaining `api.v1` and `plugin.v1` services, messages, validation rules, errors, and compatibility policy. Server foundation implementation remains Milestone 2 work governed by the approved core-server design.
