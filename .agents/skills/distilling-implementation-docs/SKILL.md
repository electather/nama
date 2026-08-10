---
name: distilling-implementation-docs
description: Use when implementation is complete and verified, and architecture, design, plan, or handoff documentation must be reconciled with code and configuration for future agents.
---

# Distilling Implementation Docs

Keep durable reasoning in documentation; let implementation remain the source
of truth for mechanics. Do not run this cleanup before the implementation and
its relevant checks pass. Do not strip an active specification for unfinished
work.

## Workflow

1. Bound the requested documents and inspect the implemented code,
   configuration, tests, generated artifacts, and current diff that own their
   claims.
2. Classify each statement:
   - **Keep or add:** decisions and rationale; invariants; trust, ownership, and
     generated-code boundaries; public API and compatibility policy; deliberate
     scope exclusions; non-obvious constraints; stable canonical file pointers;
     unresolved risks or gates; and behavior not proven by current checks. If a
     check is compile-only, retain that runtime behavior remains unproven.
   - **Remove:** copied code or configuration; exact versions, flags, commands,
     path and repository-tree inventories, and generated inventories; completed
     checklists; implementation history; CI transcripts; and external-state
     snapshots.
   - **Correct:** stale claims, contradictions, and pointers whose canonical
     owner moved.
3. Edit the smallest document set. Prefer deleting whole obsolete sections.
   Never weaken security, validation, accessibility, testing, or data-loss
   guardrails merely because their implementation exists.
4. Verify every remaining claim against current sources. Run the repository's
   documentation checks and `git diff --check HEAD`; inspect `git status
   --short` and read each untracked document because the diff omits it. Review
   the final change for lost guardrails and newly duplicated mechanics.
   Line-count reduction is not a success criterion.

Example: remove a pinned runtime version and its install command when the
manifest owns both. Retain the reason native manifests own dependency state and
the boundary that generated directories cannot contain handwritten source.

## Handoff

Report the documents changed, durable decisions retained, duplicated or stale
material removed, verification run, and any unresolved mismatch. If the bounded
implementation is incomplete, do not clean it: identify its normative
specification and stop.
