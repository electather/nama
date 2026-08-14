# GitHub Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Materialize the approved M0–M5 and MVP roadmap as repository milestones, labeled native issue hierarchies, and correctly statused items in the `Nama` GitHub Project.

**Architecture:** `docs/release-plan.md` remains the product source of truth and `docs/superpowers/specs/2026-08-14-github-roadmap-design.md` is the exact GitHub artifact manifest. Mutations use GitHub REST/GraphQL through authenticated `gh`, query exact names before creation, and finish with independent read-back verification.

**Tech Stack:** GitHub CLI, GitHub REST API, GitHub GraphQL API, GitHub Projects v2.

## Global Constraints

- Repository: `electather/nama`; project owner and title: `electather` / `Nama`.
- Create seven milestones, 13 labels, seven parent issues, and 47 native sub-issues exactly as named in the approved specification.
- The universal app lives conceptually under `apps/ios`, targets iOS 17+, tvOS 17+, and macOS 14+, and uses label `area: ios`.
- Preserve existing labels, project fields, project views, and workflows.
- Add no due dates, estimates, iterations, priority labels, personal assignees, explicit non-goal issues, Milestone 6–9 issues, or v1 issues.
- Do not push source or configure a Git remote.
- Reuse exact-name artifacts on retry; stop on conflicting duplicates.

---

### Task 1: Authenticate and resolve GitHub owners

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-github-roadmap-design.md`

**Interfaces:**
- Consumes: authenticated `electather` GitHub CLI session.
- Produces: repository node ID, project number/ID, Status field ID, and option IDs for `Backlog`, `Ready`, `In progress`, and `Done`.

- [ ] **Step 1: Grant project access**

Run interactively:

```bash
gh auth refresh -s project
```

Expected: `gh auth status` includes `project` scope.

- [ ] **Step 2: Resolve the project by exact owner and title**

Run:

```bash
gh project list --owner electather --format json
```

Expected: exactly one project titled `Nama`.

- [ ] **Step 3: Resolve project fields**

Run:

```bash
gh project field-list PROJECT_NUMBER --owner electather --format json
```

Expected: one single-select field named `Status` containing `Backlog`, `Ready`, `In progress`, `In review`, and `Done`.

### Task 2: Create repository milestones and labels

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-github-roadmap-design.md`

**Interfaces:**
- Consumes: exact milestone and label tables from the specification.
- Produces: seven milestone numbers and 13 labels available to issue creation.

- [ ] **Step 1: Query existing milestones and labels**

Run:

```bash
gh api 'repos/electather/nama/milestones?state=all&per_page=100'
gh label list --repo electather/nama --limit 100 --json name,color,description
```

Expected before first execution: no milestones; default labels plus `accessibility`.

- [ ] **Step 2: Create or reuse the seven exact-title milestones**

Use `POST repos/electather/nama/milestones` only when an exact title is absent. Send `title` and `description`; omit `due_on`. Keep M0 open until its issues are created and closed.

- [ ] **Step 3: Create or reuse the 13 exact-name labels**

Use `gh label create --repo electather/nama` with the exact color and description in the specification only when the exact label name is absent.

- [ ] **Step 4: Read back milestone and label state**

Expected: seven distinct milestone titles, no due dates, and every specified label with the approved description.

### Task 3: Create milestone parents and native sub-issues

**Files:**
- Read: `docs/release-plan.md`
- Read: `docs/superpowers/specs/2026-08-14-github-roadmap-design.md`

**Interfaces:**
- Consumes: exact issue titles, release-plan goals, Included bullets, exit criteria, and explicit non-goals.
- Produces: seven parent issue numbers, 47 child issue numbers, milestone assignments, labels, and native parent-child relationships.

- [ ] **Step 1: Create or reuse seven parent issues**

For each approved parent title, query open and closed repository issues by exact title. If absent, create it with sections `Goal`, `Dependency gate`, `Exit criteria`, `Explicit non-goals`, and `Source`; assign its repository milestone and `roadmap` label.

- [ ] **Step 2: Create or reuse 47 child issues**

For each approved child title, create a body with sections `Outcome`, `Acceptance`, `Explicit non-goals`, and `Source`. Assign the same repository milestone as its parent and the area/type/security labels specified by its requirement.

- [ ] **Step 3: Attach native sub-issue relationships**

For every parent-child pair, call:

```bash
gh api --method POST repos/electather/nama/issues/PARENT/sub_issues -F sub_issue_id=CHILD_DATABASE_ID
```

Expected: 47 children attached exactly once; no child has multiple parents.

- [ ] **Step 4: Close accepted historical issues**

Close the M0 parent and seven M0 children. Close `Validate Apple TV playback feasibility`. Leave the M1 parent and its four unresolved spike children open.

- [ ] **Step 5: Close the historical milestone**

Patch only `M0 — Contracts and workspace baseline` to state `closed` after its eight issues are closed.

### Task 4: Add issues to the project and set Status

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-github-roadmap-design.md`

**Interfaces:**
- Consumes: 54 issue URLs, project ID, Status field ID, and Status option IDs.
- Produces: 54 unique project items with approved statuses.

- [ ] **Step 1: Add every issue exactly once**

For each issue URL, reuse an existing project item when present; otherwise run:

```bash
gh project item-add PROJECT_NUMBER --owner electather --url ISSUE_URL --format json
```

- [ ] **Step 2: Set completed history to Done**

Set M0 parent/children and the completed Apple TV spike to `Done` using `gh project item-edit` with the project ID, item ID, Status field ID, and Done option ID.

- [ ] **Step 3: Set the current gate to In progress**

Set only the M1 parent to `In progress`.

- [ ] **Step 4: Set actionable M1 spikes to Ready**

Set the four unresolved M1 spike sub-issues to `Ready`.

- [ ] **Step 5: Keep future milestones in Backlog**

Set every M2–M5 and MVP parent and sub-issue to `Backlog`.

### Task 5: Verify the complete GitHub graph

**Files:**
- Read: `docs/superpowers/specs/2026-08-14-github-roadmap-design.md`

**Interfaces:**
- Consumes: GitHub read APIs only.
- Produces: count and state evidence for final delivery.

- [ ] **Step 1: Verify milestones and labels**

Expected: seven milestones; M0 closed, six open, no due dates; 13 approved added labels including `area: ios` and no `area: tvos`.

- [ ] **Step 2: Verify issues and hierarchy**

Expected: 54 issues total; seven parent issues; 47 native children; nine closed issues; 45 open issues; every issue assigned to exactly one approved milestone.

- [ ] **Step 3: Verify project membership and statuses**

Expected: all 54 issues in project `Nama`; nine `Done`, one `In progress`, four `Ready`, and 40 `Backlog`.

- [ ] **Step 4: Verify excluded mutations**

Expected: no due dates, personal assignees, future milestones, v1 issues, priority/status labels, source push, or local remote configuration.

- [ ] **Step 5: Report URLs and verification evidence**

Report the project URL, milestone count/state, issue hierarchy totals, project Status totals, and any GitHub-side limitation without claiming unverified state.
