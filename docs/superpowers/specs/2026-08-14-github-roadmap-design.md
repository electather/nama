# GitHub Roadmap Design

## Purpose

Convert the accepted MVP portion of `docs/release-plan.md` into GitHub planning artifacts for `electather/nama` and the user-owned GitHub Project named `Nama`. The GitHub model must preserve the release plan's dependency gates without replacing the release plan as the architecture source of truth.

## Scope

Create repository milestones for Milestones 0–5 and the private single-user iOS MVP release. Create one parent issue per milestone and native GitHub sub-issues for each included deliverable. Add every issue to the `Nama` project and set its project status from current repository evidence.

Do not create Milestones 6–9 or v1 issues yet. Do not assign people, invent dates or estimates, push the local repository, configure a Git remote, or change source code. Do not turn explicit non-goals into backlog issues.

## GitHub owners

- Repository: `electather/nama`
- Project owner: `electather`
- Project title: `Nama`
- Source of truth: `docs/release-plan.md`

The GitHub repository currently exists but has no pushed content. Issue bodies therefore contain the applicable release-plan requirements directly and name the source path without depending on a resolvable branch link.

## Milestones

Create these repository milestones without due dates:

| Title | Initial state | Description |
| --- | --- | --- |
| `M0 — Contracts and workspace baseline` | Closed after its issues close | Buildable polyglot workspace and provider-neutral public/private contracts. |
| `M1 — Retire the highest risks` | Open | Resolve playback, Jellyfin negotiation, plugin IPC, authentication, and synchronization risks before product implementation. |
| `M2 — Bootable core, administrator setup, and CLI` | Open | Make a fresh deployment securely configurable without a web application. |
| `M3 — Plugin runtime and Jellyfin connection` | Open | Prove Jellyfin is a stateless capability adapter behind supervised plugin IPC. |
| `M4 — iOS app pairing, browsing, and direct playback` | Open | Deliver discovery, pairing, provider-neutral browsing, and direct playback through one universal app targeting iOS, tvOS, and macOS. |
| `M5 — Canonical progress and two-way Jellyfin sync` | Open | Make Nama own durable resume/watched state while synchronizing Jellyfin. |
| `MVP — Private single-user iOS app` | Open | Release Milestones 0–5 as an installable private single-user universal Apple app. |

Milestone 0 is historical completion. The Milestone 1 Apple TV playback feasibility issue is also historical completion, but the Milestone 1 parent remains open until the other four spikes pass.

## Labels

Keep all existing repository labels. Reuse `enhancement`, `documentation`, and `accessibility` where applicable. Add only the following labels:

| Label | Color | Description |
| --- | --- | --- |
| `roadmap` | `5319E7` | Parent issue tracking an accepted release-plan milestone. |
| `spike` | `D4C5F9` | Disposable investigation that resolves a named architecture risk. |
| `security` | `B60205` | Trust-boundary, credential, authorization, or secret-handling work. |
| `area: contracts` | `0052CC` | Protobuf, ConnectRPC, generated bindings, and compatibility policy. |
| `area: tooling` | `0E8A16` | Workspace, generation, native checks, and CI tooling. |
| `area: core` | `1D76DB` | TypeScript core runtime, persistence, identity, and authorization. |
| `area: cli` | `006B75` | Go management CLI behavior and operator UX. |
| `area: plugin-runtime` | `7B42BC` | Plugin subprocess supervision, IPC, and lifecycle. |
| `area: jellyfin` | `00A4DC` | Jellyfin provider translation and negotiation. |
| `area: ios` | `555555` | Universal SwiftUI app behavior across iOS, tvOS, and macOS. |
| `area: playback` | `E99695` | Playback planning, locators, engine integration, and controls. |
| `area: sync` | `FBCA04` | Canonical user state, reconciliation, imports, and exports. |
| `area: deployment` | `BFD4F2` | Container packaging, installation, backup, restore, and recovery. |

Milestones carry release phase and the project Status field carries workflow state. Do not create milestone, priority, Backlog, Ready, In progress, Done, or release-blocker labels.

## Issue hierarchy

Use native GitHub sub-issue relationships. Do not duplicate the relationship as a manually maintained task list.

Every parent issue contains:

1. Goal from the release plan.
2. Dependency gate.
3. Exit-criteria checklist copied from the release plan.
4. Explicit non-goals copied from the release plan.
5. Source path and section name.

Every sub-issue contains:

1. Required outcome derived from exactly one Included or MVP acceptance bullet.
2. Relevant acceptance details already stated by that milestone.
3. Applicable explicit non-goals.
4. Source path and section name.

No issue may claim runtime behavior that the repository does not currently implement.

### M0 parent and sub-issues

Parent: `M0 — Contracts and workspace baseline`

1. `Establish the pnpm workspace and polyglot repository baseline`
2. `Configure native Go, Buf, Docker, and generated Swift tooling`
3. `Define provider-neutral public api.v1 services`
4. `Define private plugin.v1 services`
5. `Define canonical media and playback contract messages`
6. `Enforce deterministic generation and Protobuf compatibility in CI`
7. `Provide unified generation and repository check commands`

All eight M0 issues are created closed and placed in project status `Done`.

### M1 parent and sub-issues

Parent: `M1 — Retire the highest risks`

1. `Validate Apple TV playback feasibility` — closed; status `Done`.
2. `Prove Jellyfin playback negotiation and direct media delivery`
3. `Prove authenticated plugin subprocess IPC lifecycle`
4. `Prove Better Auth behind Nama Connect RPCs`
5. `Prove watch-state reconciliation semantics`

The parent is open with project status `In progress`. The four unresolved spikes are open with status `Ready`. Every sub-issue receives `spike`; security-sensitive spikes also receive `security`.

### M2 parent and sub-issues

Parent: `M2 — Bootable core, administrator setup, and CLI`

1. `Build the bootable Effect core lifecycle and configuration`
2. `Add PostgreSQL persistence and automatic setup/auth migrations`
3. `Implement the one-time administrator bootstrap token`
4. `Implement Connect setup and authentication handlers`
5. `Implement setup, sign-in, and status CLI flows`
6. `Complete the CLI help, JSON, completion, and exit-code contract`
7. `Add the repository skill for safe CLI operation`

The parent and all sub-issues are open with status `Backlog`.

### M3 parent and sub-issues

Parent: `M3 — Plugin runtime and Jellyfin connection`

1. `Implement authenticated plugin subprocess supervision`
2. `Start plugins on demand and stop them when idle`
3. `Persist Jellyfin instances and encrypted provider credentials`
4. `Implement Jellyfin library, playback, and watch-state capabilities`
5. `Add provider connection and capability CLI commands`
6. `Package the core and Jellyfin plugin in one image`

The parent and all sub-issues are open with status `Backlog`.

### M4 parent and sub-issues

Parent: `M4 — iOS app pairing, browsing, and direct playback`

1. `Implement iOS app discovery and manual server entry`
2. `Enforce iOS app server URL transport policy`
3. `Implement secure administrator-approved device pairing`
4. `Persist pairing, devices, canonical media, and provider mappings`
5. `Implement provider-neutral browse, search, and details`
6. `Integrate a security-reviewed playback engine behind NamaPlayer`
7. `Report Apple-device capabilities and negotiate playback fallbacks`
8. `Implement playback controls, track selection, failure, and recovery`
9. `Meet iOS, tvOS, and macOS accessibility and input requirements`

The parent and all sub-issues are open with status `Backlog`.

### M5 parent and sub-issues

Parent: `M5 — Canonical progress and two-way Jellyfin sync`

1. `Persist canonical playback position and watched state`
2. `Report idempotent playback progress and final state`
3. `Implement Continue Watching, resume, and watched controls`
4. `Schedule durable Jellyfin watch-state pull and push work`
5. `Implement reconciliation precedence and rewatch semantics`
6. `Prevent sync echoes and expose retry health`
7. `Implement initial import and conservative polling`

The parent and all sub-issues are open with status `Backlog`.

### MVP parent and sub-issues

Parent: `MVP — Release private single-user iOS app`

1. `Build the production Docker Compose deployment`
2. `Exercise the empty-install-to-playback journey`
3. `Document and exercise backup and restore`
4. `Test authentication, pairing, URL, secret, IPC, and authorization failures`
5. `Pass contract, core, CLI, and universal Apple app release checks`
6. `Verify install, upgrade, outage, and restart recovery scenarios`

The parent and all sub-issues are open with status `Backlog`. The parent depends on completion of M0–M5; the dependency is stated in its body rather than represented as a duplicated status label.

## Project assignment

Add all 54 issues—seven parents and 47 sub-issues—to the `Nama` project.

Use the existing project `Status` field:

- `Done`: M0 parent and sub-issues; completed Apple TV feasibility sub-issue.
- `In progress`: M1 parent only.
- `Ready`: the four unresolved M1 spikes.
- `Backlog`: every M2–M5 and MVP parent and sub-issue.

Preserve existing project fields, views, options, and workflows. Do not create estimates, dates, priorities, iterations, or assignee fields.

## Creation order and retry safety

1. Obtain GitHub `project` scope for the authenticated `electather` account.
2. Resolve the `nama` project by exact owner and title.
3. Create or reuse labels by exact name.
4. Create or reuse milestones by exact title.
5. Create or reuse parent issues by exact title and repository milestone.
6. Create or reuse sub-issues by exact title and repository milestone.
7. Attach each child through GitHub's native sub-issue API.
8. Add every issue to the project exactly once.
9. Set project Status values.
10. Close the historical M0 issues, completed playback spike, and M0 milestone.
11. Verify counts, milestone assignments, parent-child relationships, labels, issue states, project membership, and project statuses.

Every mutating step first queries by exact title/name and reuses matching artifacts. A retry must not create duplicates. If an unexpected same-title artifact has conflicting ownership or state, stop rather than overwrite it.

## Acceptance

The conversion is complete when:

- seven repository milestones exist with the specified state and no due dates;
- the 13 added labels exist with the specified descriptions;
- seven milestone parent issues and 47 native sub-issues exist;
- every issue has the correct repository milestone and project membership;
- M0 history and the playback feasibility spike are closed without marking unresolved work complete;
- the M1 parent is the only `In progress` item, and the four unresolved M1 spikes are `Ready`;
- all M2–M5 and MVP work is `Backlog`;
- no Milestone 6–9, v1, explicit non-goal, due date, estimate, personal assignment, source push, or remote configuration was added; and
- a final read-back confirms GitHub state instead of relying on successful mutation responses.
