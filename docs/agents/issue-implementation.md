# Local issue implementation

Nama's local issue executor implements one fully specified GitHub issue in a deterministic Sandcastle worktree and publishes a verified draft pull request. GitHub Issues remain the task authority; local state exists only for crash recovery.

## Security boundary

The proof of concept uses Sandcastle `noSandbox()` and OMP's unrestricted noninteractive tool approval. OMP runs directly as the invoking macOS user and therefore retains that user's filesystem authority, including access to files outside the worktree that the account can read. Sandcastle provides worktree separation, not filesystem or credential isolation.

The executor rejects known sensitive inherited environment variables before claiming an issue. It does not intentionally pass GitHub token environment variables to OMP; host-side `gh` commands use the invoking user's stored authentication. The host account remains the trust boundary because OMP can read files available to that account. Use a dedicated macOS runner account with independently authenticated OMP state before unattended or self-hosted execution.

The supported agent runtime is pinned to OMP `18.0.6`, model `openai-codex/gpt-5.6-sol`, and `xhigh` thinking. Sessions, prewalk, extensions, advisors, asynchronous work, browser and computer control, and subagents are disabled. The coding tool allowlist is `read,bash,edit,write,grep,glob,lsp,todo`. Updating the OMP version or JSON protocol parser is a reviewed code change.

## Plan and execute

Run commands from the repository root:

```bash
pnpm agent:issue -- 88
pnpm agent:issue -- 88 --execute
pnpm agent:issue -- 175 --capability xcode
pnpm agent:issue -- 175 --execute --capability xcode
```

The default is a mutation-free plan. It fetches `origin/main` and reads GitHub state, then reports the issue snapshot, base commit, deterministic `agent/issue-<number>` branch, required capabilities, pinned agent, full host check, intended GitHub writes, limits, and security boundary. It does not assign, relabel, create a branch or worktree, invoke OMP, push, or create a pull request.

`--execute` is the explicit mutation and quota boundary. Before claiming, execution requires all of the following:

- the issue is open, unassigned, and labelled `ready-for-agent`;
- no open native dependency blocks it;
- no local or remote deterministic implementation branch exists;
- no open pull request implements the issue;
- every capability label matches a declared and independently verified runner capability;
- exact OMP `18.0.6` is installed;
- no rejected sensitive environment variable is populated; and
- no repository-wide active-run lock exists.

`requires:xcode` is a hard scheduling label. A matching runner must pass `--capability xcode`; the executor also verifies Xcode 26 or newer and an iPhoneOS 26 or newer SDK. Absence of the label permits only the baseline runner. If an unlabeled run produces an Apple/Xcode-owned diff, publication stops and the run returns to human review rather than silently widening capability.

Execution assigns the invoking GitHub user as its first GitHub write, creates the deterministic worktree from freshly fetched `origin/main`, and runs one OMP iteration. The idle limit is ten minutes and the overall agent deadline is sixty minutes. OMP receives only the snapshotted title, body, labels, dependencies, extracted acceptance criteria, and owner/member/collaborator comments. Repository guidance outranks that snapshot.

## Terminal states and publication

OMP must emit exactly one structured terminal claim:

- `COMPLETE`: at least one issue-owned commit, clean index and worktree, no merge commit, authorized paths and boundaries, and generator-owned generated changes;
- `BLOCKED`: the exact unresolved human decision; or
- `NO_CHANGE`: the safe reason and verification evidence without a fabricated commit.

`BLOCKED` and `NO_CHANGE` remove the assignment, replace `ready-for-agent` with `ready-for-human`, add an allowlisted comment, and retain the worktree and logs. `NO_CHANGE` also runs `mise run check` on the host. Execution, validation, and check failures retain eligibility, remove the assignment, add only run ID/stage/safe error-code evidence, and retain recovery state.

A `COMPLETE` run must pass the trusted host's full `mise run check`. The executor then re-reads meaningful issue state, re-fetches `origin/main`, and refuses publication if instructions changed or the advanced base conflicts. A conflict-free advanced base may proceed without rewriting agent commits.

Publication is idempotent. The executor confirms the deterministic remote branch after every push and queries the matching pull request after every create attempt. An explicit compatible retry may use only `--force-with-lease=<recorded-sha>`; bare force pushes are never issued. The confirmed draft includes summary, exact verification evidence, limitations, run ID, model provenance, automation disclosure, and `Closes #<issue>`. Prompts, transcripts, hidden reasoning, environment data, credentials, and raw tool output remain local. `ready-for-agent` is removed only after the matching draft is confirmed; the invoking user remains assigned.

## Recovery and cleanup

Run metadata and complete local logs live under the repository's git-common directory at `.git/nama-agent/runs/<run-id>/`. The single active lock is `.git/nama-agent/active-run.json`. Sandcastle worktrees live under ignored `/.sandcastle/` state.

A normal rerun rejects a retained branch. Retry a compatible failed run explicitly:

```bash
pnpm agent:issue -- 88 --execute --retry issue-88-<timestamp>-<suffix>
```

Implementation and check retries start a fresh OMP session. When a later publication transition failed after the matching draft was already confirmed, retry validates the recorded remote SHA and exact draft, then resumes the remaining issue transition without rerunning OMP.

Retry verifies the recorded issue, branch, base ancestry, worktree, remote SHA, current admission state, and active lock before claiming again. Any pull request other than the exact recorded draft is rejected.

A crash can leave the active lock behind. Remove it only by naming the matching run after its recorded process is dead and matching run metadata exists. Recovery records a still-`running` dead run as retryable failure before removing the lock:

```bash
pnpm agent:issue -- 88 --recover-stale-lock issue-88-<timestamp>-<suffix>
```

Publication-only retry intent remains durable across another crash. A dead `published` run preserves assignment and removes the lock only after re-confirming its exact remote branch and draft, then either removing its exact registered worktree or confirming that worktree is already unregistered.

Failed, blocked, and no-change work remains until explicit cleanup. Cleanup verifies issue/run identity, status, lock ownership, Sandcastle path, branch, recorded HEAD, and a successful remote probe confirming branch absence before deleting the worktree and local branch:

```bash
pnpm agent:issue -- 88 --cleanup issue-88-<timestamp>-<suffix>
```

Successful worktrees are removed only after both the remote branch and draft pull request are confirmed.
