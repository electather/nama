# Fallow Server Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, server-local Fallow gate and a path-filtered `prek` pre-commit hook without changing Nama's other language checks.

**Architecture:** `apps/server` owns Fallow as an exact-pinned development dependency and owns its analysis policy. Existing root TypeScript and Mise checks invoke that native server command; Mise pins `prek`, while a standard `.pre-commit-config.yaml` defines the changed-server hook.

**Tech Stack:** Fallow 3.16.0, TypeScript 7.0.2, pnpm 11.20.0, prek 0.4.13, Mise 2026.8.3+

## Global Constraints

- Analyze only `apps/server`; do not include `plugins/jellyfin` or `gen/ts` in the Fallow project.
- Exact-pin `fallow` at `3.16.0` and `prek` at `0.4.13`; update owning lockfiles with native tools.
- Set every rule exercised by the supported fatal analyzers to `error`; keep `feature-flags` explicitly `off` because Fallow 3.16.0 has no fatal flag-inventory contract.
- Require complete type-aware evidence; do not accept best-effort fallback.
- Use no baseline, warning downgrade, handwritten-source blanket ignore, generated edit, or inline suppression.
- Keep Fallow's health ceilings at cyclomatic 20, cognitive 15, CRAP 30, and unit size 60; exclude only `**/*.test.ts` from health scoring.
- Gate all 46 Fallow security categories, including the include-required `hardcoded-secret` and `secret-to-network` categories.
- Pre-commit gates changed server quality only; `mise run check` remains the complete polyglot repository gate.
- Preserve the user's existing untracked `.serena/` directory and do not stage it.

---

## File Map

- Create `apps/server/.fallowrc.json`: authoritative server analysis scope, severities, thresholds, type-aware mode, security categories, and boundary coverage.
- Modify `apps/server/package.json`: exact Fallow dependency plus full and changed-file commands.
- Modify `apps/server/src/contract-authorization.ts`: make the unconsumed helper type file-local.
- Modify `package.json`: format the Fallow config and include the server gate in `check:ts`.
- Modify `pnpm-lock.yaml`: pnpm-generated exact dependency resolution.
- Create `.pre-commit-config.yaml`: portable, path-filtered local hook definition.
- Modify `mise.toml`: exact prek tool, setup-time hook installation, and Fallow-config formatting.
- Modify `mise.lock`: Mise-generated prek artifact checksums.
- Modify `.gitignore`: ignore Fallow caches at any workspace depth.
- Modify `README.md`: document setup-time hook installation and the hook/full-check boundary.
- Modify `docs/architecture/repository-and-tooling.md`: record Fallow and prek ownership without duplicating versions or command flags.

---

### Task 1: Add the strict server Fallow gate

**Files:**
- Create: `apps/server/.fallowrc.json`
- Modify: `apps/server/package.json:5-16`
- Modify: `apps/server/src/contract-authorization.ts:1`
- Modify: `package.json:5-15`
- Modify: `pnpm-lock.yaml` through pnpm only

**Interfaces:**
- Consumes: `apps/server/tsconfig.json`, the `@nama/server` workspace name, and the intentional `src/contract-probe.ts` compile entry.
- Produces: `pnpm --filter @nama/server run check:fallow` for complete supported gates and `pnpm --filter @nama/server run audit:fallow` for changed-file auditing.

- [ ] **Step 1: Add the exact server-owned dependency**

Run:

```bash
pnpm --filter @nama/server add --save-dev --save-exact fallow@3.16.0
```

Expected: `apps/server/package.json` contains `"fallow": "3.16.0"` under `devDependencies`; `pnpm-lock.yaml` resolves Fallow 3.16.0 and its version-matched optional packages. Do not hand-edit the lockfile.

- [ ] **Step 2: Create the validated server configuration**

Create `apps/server/.fallowrc.json` with exactly this policy:

```json
{
  "$schema": "./node_modules/fallow/schema.json",
  "entry": ["src/contract-probe.ts"],
  "rules": {
    "boundary-violation": "error",
    "circular-dependencies": "error",
    "coverage-gaps": "error",
    "css-broken-reference": "error",
    "css-dead-surface": "error",
    "css-duplicate-block": "error",
    "css-selector-complexity": "error",
    "css-token-drift": "error",
    "dev-dependencies-in-production": "error",
    "duplicate-exports": "error",
    "duplicate-prop-shape": "error",
    "dynamic-segment-name-conflict": "error",
    "empty-catalog-groups": "error",
    "feature-flags": "off",
    "invalid-client-export": "error",
    "misconfigured-dependency-overrides": "error",
    "misplaced-directive": "error",
    "mixed-client-server-barrel": "error",
    "policy-violation": "error",
    "private-type-leaks": "error",
    "prop-drilling": "error",
    "re-export-cycle": "error",
    "require-suppression-reason": "error",
    "route-collision": "error",
    "security-client-server-leak": "error",
    "security-sink": "error",
    "stale-suppressions": "error",
    "test-only-dependencies": "error",
    "thin-wrapper": "error",
    "type-only-dependencies": "error",
    "unlisted-dependencies": "error",
    "unprovided-injects": "error",
    "unrendered-components": "error",
    "unresolved-catalog-references": "error",
    "unresolved-imports": "error",
    "unused-catalog-entries": "error",
    "unused-class-members": "error",
    "unused-component-emits": "error",
    "unused-component-inputs": "error",
    "unused-component-outputs": "error",
    "unused-component-props": "error",
    "unused-dependencies": "error",
    "unused-dependency-overrides": "error",
    "unused-dev-dependencies": "error",
    "unused-enum-members": "error",
    "unused-exports": "error",
    "unused-files": "error",
    "unused-load-data-keys": "error",
    "unused-optional-dependencies": "error",
    "unused-server-actions": "error",
    "unused-store-members": "error",
    "unused-svelte-events": "error",
    "unused-types": "error"
  },
  "typeAware": {
    "enabled": true,
    "projects": ["tsconfig.json"],
    "require": "complete"
  },
  "duplicates": {
    "enabled": true,
    "mode": "semantic",
    "near": true,
    "minTokens": 50,
    "minLines": 5,
    "minOccurrences": 2
  },
  "health": {
    "maxCyclomatic": 20,
    "maxCognitive": 15,
    "maxCrap": 30,
    "maxUnitSize": 60,
    "ignore": ["**/*.test.ts"],
    "suggestInlineSuppression": false
  },
  "audit": {
    "gate": "new-only",
    "css": true,
    "cssDeep": true
  },
  "security": {
    "categories": {
      "include": [
        "angular-trusted-html",
        "cleartext-transport",
        "code-injection",
        "command-injection",
        "dangerous-html",
        "deprecated-cipher",
        "dom-document-write",
        "dynamic-module-load",
        "dynamic-regex",
        "electron-unsafe-webpreferences",
        "hardcoded-secret",
        "header-injection",
        "insecure-cookie",
        "insecure-randomness",
        "insecure-temp-file",
        "jquery-html",
        "jwt-alg-none",
        "jwt-verify-missing-algorithms",
        "llm-call-injection",
        "mass-assignment",
        "mysql-multiple-statements",
        "nextjs-open-redirect",
        "nosql-injection",
        "open-redirect",
        "path-traversal",
        "permissive-cors",
        "postmessage-wildcard-origin",
        "prototype-pollution",
        "redos-regex",
        "resource-amplification",
        "route-send-file",
        "secret-pii-log",
        "secret-to-network",
        "sql-injection",
        "ssrf",
        "ssti",
        "template-escape-bypass",
        "tls-validation-disabled",
        "unsafe-buffer-alloc",
        "unsafe-deserialization",
        "weak-crypto",
        "webview-injection",
        "world-writable-permission",
        "xpath-injection",
        "xxe",
        "zip-slip"
      ],
      "exclude": []
    }
  },
  "boundaries": {
    "zones": [{ "name": "contracts", "patterns": ["src/contract*.ts"] }],
    "rules": [{ "from": "contracts", "allow": [] }],
    "coverage": {
      "requireAllFiles": true,
      "allowUnmatched": []
    }
  }
}
```

The `src/contract*.ts` pattern is intentional: it covers both the hyphenated compile-boundary modules and `src/contract.test.ts`. A narrower `src/contract-*.ts` pattern leaves the test unzoned and must not be used.

- [ ] **Step 3: Add the server and root commands**

Set the server scripts to include these exact commands while preserving `check:contract` and `check:type`:

```json
{
  "scripts": {
    "audit:fallow": "fallow audit --base HEAD --quiet",
    "check:contract": "node --test src/contract.test.ts",
    "check:fallow": "fallow --fail-on-issues && fallow security --fail-on-issues",
    "check:type": "tsc --project tsconfig.json --noEmit"
  }
}
```

Update the root scripts so the new config is formatted explicitly and the Fallow gate runs inside the existing TypeScript sequence:

```json
{
  "scripts": {
    "check:format": "oxfmt --check .oxfmtrc.json .oxlintrc.json package.json tsconfig.base.json apps/server/.fallowrc.json apps/server plugins/jellyfin gen/ts/package.json",
    "check:lint": "oxlint apps/server plugins/jellyfin",
    "check:ts": "pnpm run check:format && pnpm run check:lint && pnpm --filter @nama/server --fail-if-no-match run check:fallow && pnpm run check:type && pnpm --filter @nama/server run check:contract",
    "check:type": "pnpm --filter @nama/server --fail-if-no-match run check:type && pnpm --filter @nama/jellyfin --fail-if-no-match run check:type"
  }
}
```

- [ ] **Step 4: Format the new native configuration and manifests**

Run:

```bash
pnpm exec oxfmt apps/server/.fallowrc.json apps/server/package.json package.json
```

Expected: command exits 0 and preserves the policy values above.

- [ ] **Step 5: Run the focused gate and verify the existing finding**

Run:

```bash
pnpm --filter @nama/server run check:fallow
```

Expected: FAIL only because `ContractAuthority` in `apps/server/src/contract-authorization.ts:1` is an exported type with no external consumer. The intentional `contract-probe.ts` is not reported as unused, `contract.test.ts` is zoned, type-aware completeness is `complete`, duplication has no clone groups, and production-source health has no threshold finding.

If any additional finding appears, stop and fix its source or correct an inaccurate entry/boundary declaration. Do not add a suppression, ignore, baseline, or severity downgrade.

- [ ] **Step 6: Make the helper type file-local**

Change only the declaration keyword in `apps/server/src/contract-authorization.ts`:

```ts
type ContractAuthority =
  | "administrator"
  | "device"
  | "plugin-bearer"
  | "polling-token"
  | "public";
```

Keep `contractAuthorityByMethod` unchanged. Symbol-aware reference analysis has already established that `ContractAuthority` has no external consumer.

- [ ] **Step 7: Verify the server gate and existing server contracts**

Run:

```bash
pnpm --filter @nama/server run check:fallow
pnpm --filter @nama/server run check:type
pnpm --filter @nama/server run check:contract
pnpm run check:format
```

Expected: all four commands exit 0. The security command may report unresolved dynamic call sites as analyzer limitations, but it must report zero security candidates.

- [ ] **Step 8: Commit the server gate**

```bash
git add apps/server/.fallowrc.json apps/server/package.json apps/server/src/contract-authorization.ts package.json pnpm-lock.yaml
git commit -m "build(server): add strict Fallow gate"
```

Do not stage `.serena/`.

---

### Task 2: Add the prek pre-commit integration

**Files:**
- Create: `.pre-commit-config.yaml`
- Modify: `mise.toml:3-27`
- Modify: `mise.lock` through Mise only
- Modify: `.gitignore:1-15`
- Modify: `README.md:17-25`
- Modify: `docs/architecture/repository-and-tooling.md:12-31`

**Interfaces:**
- Consumes: Task 1's `audit:fallow` script and the existing `mise run setup` bootstrap command.
- Produces: an installed `pre-commit` Git shim managed by `prek`, triggered only by server/shared-TypeScript staged paths.

- [ ] **Step 1: Pin prek through Mise**

Run:

```bash
mise use --pin prek@0.4.13
mise lock
```

Expected: `mise.toml` contains `prek = "0.4.13"`; `mise.lock` contains a generated `tools.prek` entry and platform checksums. Do not hand-edit `mise.lock`.

- [ ] **Step 2: Create the portable hook configuration**

Create `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: fallow-server
        name: Fallow server changed-file audit
        entry: pnpm --filter @nama/server run audit:fallow
        language: system
        pass_filenames: false
        files: ^(apps/server/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.base\.json$)
        stages: [pre-commit]
```

The hook receives no filenames because Fallow must inspect the complete server graph to retain dependency, cycle, and boundary findings. The `files` expression only decides whether staged paths trigger the hook.

- [ ] **Step 3: Install the hook during repository setup**

Update `mise.toml` so setup installs exactly the pre-commit shim after dependency verification:

```toml
[tasks.setup]
description = "Resolve dependencies and install Git hooks"
run = [
  "pnpm install --frozen-lockfile",
  "go mod download",
  "git diff --exit-code -- go.mod go.sum",
  "prek install --hook-type pre-commit",
]
```

Also add the server Fallow config to the existing formatter command without changing the Go or Swift formatters:

```toml
[tasks.format]
description = "Format handwritten source files"
run = [
  "pnpm exec oxfmt .oxfmtrc.json .oxlintrc.json package.json tsconfig.base.json apps/server/.fallowrc.json apps/server plugins/jellyfin gen/ts/package.json",
  "gofmt -w apps/cli gen/go",
  "DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift format format --in-place gen/swift/Package.swift",
]
```

- [ ] **Step 4: Ignore Fallow caches**

Add this unanchored directory pattern near the other tool caches in `.gitignore`:

```gitignore
.fallow/
```

The unanchored form intentionally ignores both a root cache and `apps/server/.fallow/`.

- [ ] **Step 5: Record durable tooling ownership**

Add these two bullets after the JavaScript native-configuration bullet in `docs/architecture/repository-and-tooling.md`:

```markdown
- Server-local Fallow configuration owns graph-oriented checks for handwritten
  server TypeScript; Oxlint and TypeScript remain the lint and type owners.
- The root pre-commit configuration owns portable hooks, executed by the
  Mise-pinned prek binary. Path-scoped hooks do not replace aggregate repository
  verification.
```

Add this paragraph after the bootstrap command block in `README.md`:

```markdown
`mise run setup` resolves locked dependencies and installs the repository's
pre-commit hook. The hook gates changed server quality; `mise run check` remains
the complete repository verification command.
```

Do not add tool versions or duplicate hook flags to the architecture record.

- [ ] **Step 6: Format and validate configuration**

Run:

```bash
pnpm exec oxfmt apps/server/.fallowrc.json package.json apps/server/package.json
prek validate-config .pre-commit-config.yaml
mise run setup
```

Expected: oxfmt and prek validation exit 0; setup uses frozen dependency state, leaves `go.mod` and `go.sum` unchanged, and reports successful pre-commit hook installation.

- [ ] **Step 7: Prove the hook rejects a new server defect**

Create `apps/server/src/fallow-hook-probe.ts` with:

```ts
export const fallowHookProbe = true;
```

Stage only that probe and run the real hook stage:

```bash
git add apps/server/src/fallow-hook-probe.ts
prek run --stage pre-commit fallow-server
```

Expected: FAIL because the staged server file is outside the required boundary zone and is unused. This proves both the path trigger and Fallow audit gate execute.

Clean up only the probe created by this step:

```bash
git restore --staged apps/server/src/fallow-hook-probe.ts
rm apps/server/src/fallow-hook-probe.ts
```

Do not reset, restore, or delete any other working-tree path.

- [ ] **Step 8: Prove the clean hook path passes and unrelated paths skip**

Run:

```bash
prek run --stage pre-commit --all-files fallow-server
prek run --stage pre-commit --files README.md
```

Expected: the explicit `fallow-server` run passes; the README-only run skips the Fallow hook because it does not match the configured path expression.

- [ ] **Step 9: Commit the hook and tooling records**

```bash
git add .pre-commit-config.yaml .gitignore README.md docs/architecture/repository-and-tooling.md mise.toml mise.lock
git commit -m "chore: add prek server quality hook"
```

Do not stage `.serena/`.

---

### Task 3: Verify the complete repository gate

**Files:**
- Verify only; no source or configuration edits are expected.

**Interfaces:**
- Consumes: Task 1's Fallow commands and Task 2's installed prek hook.
- Produces: completed native-check evidence for the server gate, hook, TypeScript workspace, and full polyglot repository.

- [ ] **Step 1: Verify Fallow resolution and semantic support**

Run:

```bash
pnpm --filter @nama/server exec fallow config --format json
pnpm --filter @nama/server exec fallow type-aware status
pnpm --filter @nama/server run check:fallow
```

Expected: the resolved config path is `apps/server/.fallowrc.json`; the entry list includes only `src/contract-probe.ts`; type-aware package, protocol, and backend versions match Fallow 3.16.0; the combined gate exits 0 with complete semantic evidence and zero findings.

- [ ] **Step 2: Verify the committed hook configuration and installed shim**

Run:

```bash
prek validate-config .pre-commit-config.yaml
prek run --stage pre-commit --all-files fallow-server
```

Expected: configuration validation succeeds and the server audit hook passes.

- [ ] **Step 3: Run the owning TypeScript check**

Run:

```bash
mise run check:ts
```

Expected: format, Oxlint, Fallow, TypeScript, and contract checks all exit 0.

- [ ] **Step 4: Run every repository check**

Run:

```bash
mise run check
```

Expected: contract schema/format/build/drift, TypeScript, Go formatting/vet/tests, and Docker Compose model checks all exit 0.

- [ ] **Step 5: Confirm cleanup and generated-code isolation**

Run:

```bash
git diff --exit-code -- gen
git status --short
```

Expected: no generated-code diff, no `.fallow/` cache entry, no probe file, and no uncommitted implementation change. The pre-existing untracked `.serena/` directory may remain and must not be modified or committed.
