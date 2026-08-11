# Boundary Agent Instructions Design

Status: approved on 2026-08-11.

## Decision

Add short `AGENTS.md` files at six repository boundaries:

- `apps/server`
- `apps/cli`
- `apps/tvos`
- `plugins/jellyfin`
- `proto`
- `gen`

Each file links to the canonical architecture notes for its subtree and states
only the local rules an agent must preserve. Do not add nested instruction files
or copy implementation mechanics from manifests and configuration.

## Required guidance

- Server instructions preserve core ownership, public/private contract
  separation, and the distinction between contract definitions and unimplemented
  runtime behavior.
- CLI instructions preserve the thin public-client boundary and keep business
  rules, Better Auth types, and provider-private types out of the CLI.
- tvOS instructions preserve generated public-client use, app-owned models, the
  player-adapter boundary, and safe direct playback.
- Jellyfin instructions preserve the stateless private-plugin boundary, keep
  provider details out of public contracts, and prohibit plugin-owned durable
  state.
- Protobuf instructions make `api-contracts.md` mandatory reading and require
  every schema change to update it. They prohibit hand-editing or testing
  generated bindings; handwritten tests remain for Nama-owned policy only.
- Generated-output instructions prohibit handwritten source, manifests, tests,
  and direct edits. Changes arrive only through the repository generation task.

## Verification

Verify all six files exist, every relative documentation link resolves, no
nested `AGENTS.md` was added, and `git diff --check HEAD` passes. No application
or generated-code test is needed for documentation-only instruction files.
