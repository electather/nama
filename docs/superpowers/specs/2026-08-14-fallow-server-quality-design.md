# Fallow Server Quality Design

Status: approved on 2026-08-14.

## Purpose

Add Fallow as a strict, server-owned TypeScript codebase-intelligence gate. Run its complete supported gate surface for `apps/server`, integrate it into the existing TypeScript and repository checks, and provide a fast changed-file pre-commit gate through a hook manager suitable for Nama's polyglot monorepo.

The setup must not analyze the Jellyfin plugin or generated TypeScript, establish a second root build graph, weaken findings through a baseline, or edit generated code.

## Ownership and dependencies

`apps/server/package.json` owns an exact `fallow@3.16.0` development dependency and the server-local Fallow commands. `apps/server/.fallowrc.json` owns analysis policy because the requested scope is the server, not every JavaScript workspace.

Mise owns an exact `prek@0.4.13` binary. `prek` is a single Rust binary, needs no Python runtime, consumes the standard pre-commit configuration format, and supports additional language-specific hooks later without changing hook managers. The committed `.pre-commit-config.yaml` owns the hook definition.

No other dependency or hook framework is introduced.

## Fallow scope and entry points

Fallow runs with `apps/server` as its project root. Tests continue to be discovered through Fallow's built-in test support. `src/contract-probe.ts` is configured as an explicit entry point because it intentionally imports every generated contract namespace as a compile probe and is not reached by another source file.

Generated bindings, the Jellyfin plugin, and root-level non-TypeScript workspaces remain outside this Fallow project. Fallow's cache directory is ignored by Git.

## Strict analysis policy

Every rule key exercised by Fallow's strict analysis commands is explicit and set to `error`. This includes rules that otherwise default to `warn` or `off`: private type leaks, suppression hygiene, coverage gaps, styling drift, security candidates, dependency placement, catalogue hygiene, component health, and framework boundary findings. Technology-specific rules remain dormant when their corresponding source forms or frameworks are absent.

Type-aware analysis is enabled for `tsconfig.json` with completeness required. A missing, mismatched, or incomplete semantic companion is a hard failure rather than a syntactic fallback.

Duplication analysis is enabled in semantic mode with near-duplicate detection, the documented 50-token and five-line minimums, and two occurrences as the reporting floor. This maximizes useful detection without inventing a smaller project-specific fragment threshold.

Health analysis keeps Fallow's documented SIG-aligned ceilings: cyclomatic complexity 20, cognitive complexity 15, CRAP 30, and unit size 60 lines. `*.test.ts` files are excluded only from health analysis because Fallow's static coverage estimate cannot meaningfully assign coverage to test callbacks; dead-code, dependency, duplicate, type-aware, and other applicable checks still inspect tests.

The default Fallow pipeline gates dead code, dependencies, cycles, duplication, and health. A separate `fallow security --fail-on-issues` invocation gates security candidates. Ordinary security categories and the two include-required categories, `hardcoded-secret` and `secret-to-network`, are enabled. Findings are treated as review-blocking candidates, not automatically as confirmed vulnerabilities. The separate `feature-flags` inventory remains explicitly off: Fallow 3.16.0 rejects `flags --fail-on-issues`, and Nama does not add a bespoke JSON-parsing gate around an unsupported CLI contract.

No baseline, warning downgrade, blanket handwritten-source ignore, or inline suppression is part of initial adoption.

## Architecture boundary policy

The current contract files form one `contracts` zone through the `src/contract*.ts` pattern, which includes both hyphenated modules and `contract.test.ts`. The zone has an explicit empty cross-zone allowlist; same-zone imports remain allowed by Fallow. Boundary coverage requires every analyzed source file to belong to a zone.

This gives the current compile-only contract boundary an accurate home without guessing the future runtime's directory structure. When runtime modules arrive, unzoned files fail until the Fallow boundary configuration is extended to match the accepted modular-monolith architecture.

## Command integration

The server manifest exposes:

- `check:fallow`: full Fallow pipeline with all findings fatal, followed by the separate fatal security scan;
- `audit:fallow`: Fallow's changed-file audit against `HEAD`, quiet enough for pre-commit use.

The root `check:ts` command invokes the server Fallow check alongside the existing formatter, Oxlint, TypeScript, and contract checks. Existing `mise run check:ts`, `mise run check`, and the Linux CI TypeScript job therefore gain Fallow without a new CI workflow or orchestration layer.

`mise run setup` continues to install locked ecosystem dependencies and additionally installs the committed pre-commit hook through `prek install`. The setup description is updated to name both responsibilities.

## Pre-commit behavior

The committed local hook:

- runs only at the `pre-commit` stage;
- triggers when staged paths touch `apps/server`, the root or server Node manifests, the pnpm lock/workspace definition, or shared TypeScript configuration;
- runs `pnpm --filter @nama/server run audit:fallow` from the repository environment;
- lets Fallow analyze the complete server graph but gates newly introduced findings in the changed surface;
- does not receive staged filenames as positional source arguments, because file-only dead-code analysis would suppress project-wide dependency and graph findings.

The hook does not run Go, Protobuf, Swift, or Docker checks. The selected pre-commit scope is changed server quality; full polyglot verification remains `mise run check`. `prek` is chosen so those language-specific hooks can be added later if a separate requirement calls for them.

## Existing findings

Initial adoption resolves findings rather than hiding them:

- declare `src/contract-probe.ts` as the intentional entry point;
- make `ContractAuthority` file-local because symbol-aware reference analysis found no external consumer.

No other source behavior changes are part of this setup.

## Failure behavior

Configuration errors, missing type-aware support, analyzer failures, security candidates, and error-severity findings fail the owning command. The pre-commit hook blocks only when its server-related trigger matches and the changed-file audit fails. It does not swallow fatal Fallow errors or reinterpret exit codes.

## Verification

Implementation is complete only after all of the following succeed:

1. Fallow reports the expected server root, explicit compile-probe entry, complete type-aware companion, and active boundary coverage.
2. The full server Fallow pipeline and security scan complete without findings.
3. `prek` validates the committed configuration, installs the pre-commit hook, and executes the server hook successfully at the pre-commit stage.
4. `mise run check:ts` succeeds.
5. `mise run check` succeeds.
6. Git shows no generated-code edits or untracked Fallow cache content.
