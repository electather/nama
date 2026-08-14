# Authenticated Plugin IPC Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove authenticated generated plugin RPCs over a Unix-socket subprocess lifecycle on macOS and Linux, record the evidence, and retire the disposable implementation in the same branch.

**Architecture:** A temporary server-workspace test launches a separate Node child through a core-owned mode-`0700` directory. ConnectRPC 2.1.2 serves and calls generated `HealthService.Check` and `LibraryService.GetItem` over HTTP/1.1 with `nodeOptions.socketPath`; stdin carries the per-launch socket path and bearer, interceptors enforce authentication, and the parent owns deadlines, termination, restart, and cleanup. After macOS and Linux pass, only the design and architecture evidence remain.

**Tech Stack:** Node.js 24.19.0, TypeScript 7 native type stripping, Node test runner, `@connectrpc/connect` 2.1.2, `@connectrpc/connect-node` 2.1.2, generated Protobuf-ES plugin.v1 bindings, Unix domain sockets, Docker `node:24.19.0-bookworm-slim`.

## Global Constraints

- Execute only GitHub sub-issue #17; do not implement the Milestone 3 production supervisor.
- Keep the plugin stateless; it receives no database, durable cursor, provider credentials, or persistence path.
- Create the socket only inside a core-owned runtime directory explicitly set to mode `0700`.
- Generate a new 32-byte random bearer for every launch and never place the bearer or socket path in argv, environment variables, output, errors, test names, or evidence.
- Use generated `nama.plugin.v1` services and messages; do not change `proto/` or `gen/`.
- Temporarily exact-pin only `@connectrpc/connect@2.1.2` and `@connectrpc/connect-node@2.1.2`.
- Exercise `HealthService.Check` and `LibraryService.GetItem`, an explicit deadline, clean termination, same-path restart, stale-bearer rejection, and an empty runtime directory after each stop.
- Verify natively on Darwin arm64 and in `node:24.19.0-bookworm-slim` Linux.
- Remove all executable spike files and temporary dependency/lock changes before final repository checks.

---

## File Structure

Temporary files, deleted before final delivery:

- `apps/server/src/plugin-ipc-lifecycle.test.ts` — one behavioral test over only safe evidence fields.
- `apps/server/src/plugin-ipc-lifecycle.ts` — core-owned launch, generated clients, deadline, stop, restart, output-redaction checks, and cleanup.
- `apps/server/src/plugin-ipc-child.ts` — stateless subprocess fixture serving two generated plugin RPCs.
- `apps/server/package.json` and `pnpm-lock.yaml` — exact ConnectRPC dependencies while the spike runs.

Permanent files:

- `docs/architecture/plugin-system.md` — dated platform evidence, conclusion, and explicit limits.
- `docs/superpowers/specs/2026-08-14-plugin-ipc-lifecycle-design.md` — approved design.
- `docs/superpowers/plans/2026-08-14-plugin-ipc-lifecycle.md` — this plan.

### Task 1: Write the red lifecycle behavior

**Files:**
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/server/src/plugin-ipc-lifecycle.test.ts`
- Create: `apps/server/src/plugin-ipc-lifecycle.ts`

**Interfaces:**
- Consumes: generated `ServingStatus`, `MediaKind`, and Connect `Code` enums.
- Produces: `provePluginIpcLifecycle(): Promise<PluginIpcEvidence>` and the safe scalar `PluginIpcEvidence` result used by the focused test.

- [ ] **Step 1: Install the approved exact dependencies**

Run:

```bash
pnpm --filter @nama/server add --save-exact @connectrpc/connect@2.1.2 @connectrpc/connect-node@2.1.2
```

Check `apps/server/package.json` contains exactly `2.1.2` for both packages and no unrelated dependency changed.

- [ ] **Step 2: Add the focused behavioral test**

Create `apps/server/src/plugin-ipc-lifecycle.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { Code } from "@connectrpc/connect";
import { ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

import { provePluginIpcLifecycle } from "./plugin-ipc-lifecycle.ts";

void test("authenticated plugin subprocess restarts without durable state", { timeout: 10_000 }, async () => {
  const evidence = await provePluginIpcLifecycle();

  assert.equal(evidence.runtimeDirectoryMode, 0o700);
  assert.equal(evidence.firstHealthStatus, ServingStatus.SERVING);
  assert.equal(evidence.secondHealthStatus, ServingStatus.SERVING);
  assert.equal(evidence.healthAfterDeadlineStatus, ServingStatus.SERVING);
  assert.equal(evidence.firstItemTitle, "IPC Lifecycle Fixture");
  assert.equal(evidence.secondItemTitle, "IPC Lifecycle Fixture");
  assert.equal(evidence.firstItemKind, MediaKind.MOVIE);
  assert.equal(evidence.secondItemKind, MediaKind.MOVIE);
  assert.equal(evidence.invalidBearerCode, Code.Unauthenticated);
  assert.equal(evidence.staleBearerCode, Code.Unauthenticated);
  assert.equal(evidence.deadlineCode, Code.DeadlineExceeded);
  assert.equal(evidence.firstExitCode, 0);
  assert.equal(evidence.secondExitCode, 0);
  assert.equal(evidence.filesAfterFirstStop, 0);
  assert.equal(evidence.filesAfterSecondStop, 0);
  assert.equal(evidence.sensitiveOutputAbsent, true);
});
```

The test never imports, returns, or asserts the private fixture reference, socket path, or either bearer.

- [ ] **Step 3: Add the intentionally unimplemented proof boundary**

Create `apps/server/src/plugin-ipc-lifecycle.ts`:

```ts
import type { Code } from "@connectrpc/connect";
import type { ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import type { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

export interface PluginIpcEvidence {
  readonly runtimeDirectoryMode: number;
  readonly firstHealthStatus: ServingStatus;
  readonly secondHealthStatus: ServingStatus;
  readonly healthAfterDeadlineStatus: ServingStatus;
  readonly firstItemTitle: string;
  readonly secondItemTitle: string;
  readonly firstItemKind: MediaKind;
  readonly secondItemKind: MediaKind;
  readonly invalidBearerCode: Code;
  readonly staleBearerCode: Code;
  readonly deadlineCode: Code;
  readonly firstExitCode: number;
  readonly secondExitCode: number;
  readonly filesAfterFirstStop: number;
  readonly filesAfterSecondStop: number;
  readonly sensitiveOutputAbsent: boolean;
}

export async function provePluginIpcLifecycle(): Promise<PluginIpcEvidence> {
  throw new Error("plugin IPC lifecycle spike not implemented");
}
```

This is the only temporary red-state stub. Task 2 replaces it completely.

- [ ] **Step 4: Run the focused test and retain the intended red evidence**

Run:

```bash
pnpm --filter @nama/server exec node --test src/plugin-ipc-lifecycle.test.ts
```

Expected: one failing test whose cause is exactly `plugin IPC lifecycle spike not implemented`. A module-resolution, TypeScript, generated-contract, or dependency failure is not the required red result and must be corrected before Task 2.

### Task 2: Implement and pass the macOS lifecycle proof

**Files:**
- Create: `apps/server/src/plugin-ipc-child.ts`
- Replace: `apps/server/src/plugin-ipc-lifecycle.ts`
- Test: `apps/server/src/plugin-ipc-lifecycle.test.ts`

**Interfaces:**
- Consumes: stdin JSON `{ socketPath: string; bearer: string; getItemDelayMs: number }`, generated service descriptors, `node:http`, and ConnectRPC interceptors.
- Produces: a child readiness IPC message `{ type: "ready" }`, two authenticated generated RPCs, safe Connect codes, and `PluginIpcEvidence` with no secret-bearing values.

- [ ] **Step 1: Implement the stateless child fixture**

Create `apps/server/src/plugin-ipc-child.ts` with these exact invariants:

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  HealthService,
  ServingStatus,
} from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

interface Bootstrap {
  readonly socketPath: string;
  readonly bearer: string;
  readonly getItemDelayMs: number;
}

const MAX_BOOTSTRAP_BYTES = 4_096;
const FIXTURE_ITEM_REFERENCE = "ipc-spike-item";
const FIXTURE_TITLE = "IPC Lifecycle Fixture";

function bearerMatches(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const presentedDigest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

function authenticationInterceptor(expectedBearer: string): Interceptor {
  return (next) => async (request) => {
    const authorization = request.header.get("authorization");
    const presented = authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length)
      : "";
    if (!bearerMatches(expectedBearer, presented)) {
      throw new ConnectError("plugin authentication failed", Code.Unauthenticated);
    }
    return next(request);
  };
}

async function readBootstrap(): Promise<Bootstrap> {
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BOOTSTRAP_BYTES) {
      throw new Error("plugin bootstrap invalid");
    }
  }
  const value: unknown = JSON.parse(body);
  if (typeof value !== "object" || value === null) {
    throw new Error("plugin bootstrap invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.socketPath !== "string" ||
    !isAbsolute(record.socketPath) ||
    typeof record.bearer !== "string" ||
    record.bearer.length < 43 ||
    typeof record.getItemDelayMs !== "number" ||
    !Number.isInteger(record.getItemDelayMs) ||
    record.getItemDelayMs < 1 ||
    record.getItemDelayMs > 1_000
  ) {
    throw new Error("plugin bootstrap invalid");
  }
  return {
    socketPath: record.socketPath,
    bearer: record.bearer,
    getItemDelayMs: Number(record.getItemDelayMs),
  };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("plugin socket bind failed"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function close(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(new Error("plugin shutdown failed"));
    });
  });
  await rm(socketPath, { force: true });
}

async function main(): Promise<void> {
  const bootstrap = await readBootstrap();
  const handler = connectNodeAdapter({
    interceptors: [authenticationInterceptor(bootstrap.bearer)],
    routes: (router) => {
      router.service(HealthService, {
        check: () => ({ status: ServingStatus.SERVING }),
      });
      router.service(LibraryService, {
        getItem: async (request) => {
          if (request.itemReference?.itemId !== FIXTURE_ITEM_REFERENCE) {
            throw new ConnectError("provider item not found", Code.NotFound);
          }
          await delay(bootstrap.getItemDelayMs);
          return {
            item: {
              itemReference: { itemId: FIXTURE_ITEM_REFERENCE },
              kind: MediaKind.MOVIE,
              title: FIXTURE_TITLE,
              kindDetails: { case: "movie", value: {} },
            },
          };
        },
      });
    },
  });
  const server = createServer(handler);
  let stopping = false;
  process.once("SIGTERM", () => {
    if (stopping) return;
    stopping = true;
    void close(server, bootstrap.socketPath).then(
      () => {
        process.disconnect();
        process.exitCode = 0;
      },
      () => {
        process.disconnect();
        process.exitCode = 1;
      },
    );
  });
  await listen(server, bootstrap.socketPath);
  process.send?.({ type: "ready" });
}

void main().catch(() => {
  if (process.connected) process.disconnect();
  process.exitCode = 1;
});
```

Do not add logging. A startup or shutdown defect exits non-zero without returning the raw cause.

- [ ] **Step 2: Replace the red stub with the core lifecycle harness**

Replace `apps/server/src/plugin-ipc-lifecycle.ts`. Keep the exported interface from Task 1 and implement these concrete units:

```ts
const RPC_TIMEOUT_MS = 500;
const DEADLINE_PROBE_MS = 5;
const GET_ITEM_DELAY_MS = 75;
const CHILD_LIFECYCLE_TIMEOUT_MS = 2_000;
const FIXTURE_ITEM_REFERENCE = "ipc-spike-item";

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

interface RunningPlugin {
  readonly child: ChildProcess;
  readonly output: CapturedOutput;
}

function bearerInterceptor(bearer: string): Interceptor {
  return (next) => async (request) => {
    request.header.set("authorization", `Bearer ${bearer}`);
    return next(request);
  };
}

function clients(socketPath: string, bearer: string) {
  const transport = createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "1.1",
    nodeOptions: { socketPath },
    interceptors: [bearerInterceptor(bearer)],
    acceptCompression: [],
  });
  return {
    health: createClient(HealthService, transport),
    library: createClient(LibraryService, transport),
  };
}

async function connectCode(operation: () => Promise<unknown>): Promise<Code> {
  try {
    await operation();
  } catch (error) {
    return ConnectError.from(error).code;
  }
  throw new Error("expected plugin RPC failure");
}
```

The completed file must also:

1. Create `mkdtemp(join(tmpdir(), "nama-plugin-ipc-"))`, run `chmod(runtimeDirectory, 0o700)`, and read `stat.mode & 0o777` into the safe evidence.
2. Generate each bearer with `randomBytes(32).toString("base64url")` and verify the second differs from the first without returning either value.
3. Launch `plugin-ipc-child.ts` through `fork()` with `stdio: ["pipe", "pipe", "pipe", "ipc"]`, `env: {}`, and `execArgv: ["--no-warnings"]`.
4. Accumulate child stdout/stderr privately, write the bootstrap JSON to stdin once, end stdin, and wait at most 2 seconds for exactly `{ type: "ready" }`. Convert startup, exit, timeout, and write failures into fixed safe errors without appending raw causes.
5. Call health and `GetItem` with `timeoutMs: 500`; map only `status`, `title`, and `kind` into evidence.
6. Call health with a fixed invalid bearer and capture `Code.Unauthenticated`.
7. Call delayed `GetItem` with `timeoutMs: 5`, capture `Code.DeadlineExceeded`, then call health again to prove the child remains serving.
8. Send `SIGTERM`, wait at most 2 seconds for exit code 0, and count `readdir(runtimeDirectory).length`.
9. Restart on `join(runtimeDirectory, "plugin.sock")` with the second bearer. Call health through the old bearer and capture `Code.Unauthenticated`; call health and `GetItem` through the new bearer; stop and count files again.
10. Check the combined captured output against the socket path, both bearers, and `FIXTURE_ITEM_REFERENCE`, and require the output to be empty. Return only the boolean result.
11. Use `finally` to send `SIGKILL` only to a child still alive after normal cleanup and run `rm(runtimeDirectory, { recursive: true, force: true })`.

Required imports are Node `child_process`, `crypto`, `fs/promises`, `os`, `path`, `url`, and `events`; Connect `Code`, `ConnectError`, `createClient`, and `Interceptor`; `createConnectTransport`; and generated health/library service descriptors plus media enums.

- [ ] **Step 3: Run the focused test green on macOS**

Run:

```bash
pnpm --filter @nama/server exec node --test src/plugin-ipc-lifecycle.test.ts
```

Expected: one passing test; no child stdout/stderr; process exits without open handles.

- [ ] **Step 4: Run owning TypeScript checks while the spike exists**

Run:

```bash
pnpm exec oxfmt --write apps/server/src/plugin-ipc-child.ts apps/server/src/plugin-ipc-lifecycle.ts apps/server/src/plugin-ipc-lifecycle.test.ts apps/server/package.json
pnpm --filter @nama/server run check:type
pnpm exec oxlint apps/server
pnpm --filter @nama/server run check:contract
```

Expected: all commands exit 0. Re-run the focused test after formatting if formatting changed any temporary file.

- [ ] **Step 5: Commit the green macOS proof**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/plugin-ipc-child.ts apps/server/src/plugin-ipc-lifecycle.ts apps/server/src/plugin-ipc-lifecycle.test.ts
git commit -m "test(server): prove plugin IPC lifecycle" -m "Refs #17"
```

### Task 3: Prove Linux behavior and record durable evidence

**Files:**
- Modify: `docs/architecture/plugin-system.md`
- Test: `apps/server/src/plugin-ipc-lifecycle.test.ts`

**Interfaces:**
- Consumes: the exact macOS-green spike from Task 2 and Docker image `node:24.19.0-bookworm-slim`.
- Produces: durable evidence scoped to the tested versions, methods, platforms, and non-goals.

- [ ] **Step 1: Run the identical proof in Linux**

Run from the repository root:

```bash
docker run --rm --mount type=bind,src="$PWD",dst=/workspace --workdir /workspace node:24.19.0-bookworm-slim node --test apps/server/src/plugin-ipc-lifecycle.test.ts
```

Expected: one passing test. If the exact image is unavailable or Docker cannot run Linux containers, report that as a blocker; do not substitute another Node or distro tag.

- [ ] **Step 2: Append the evidence record**

Append this section to `docs/architecture/plugin-system.md` after both platform commands pass:

```markdown

## Milestone 1 IPC spike evidence

On 2026-08-14, a disposable behavioral spike exercised generated `nama.plugin.v1.HealthService.Check` and `nama.plugin.v1.LibraryService.GetItem` through ConnectRPC 2.1.2 over an HTTP/1.1 Unix domain socket. It passed natively with Node.js 24.19.0 on Darwin 25.6.0 arm64 and in the `node:24.19.0-bookworm-slim` Linux container.

The core created and verified a mode-`0700` runtime directory. Each launch received a new 32-byte bearer and the socket path through stdin, inherited no environment, and emitted no stdout or stderr. Every registered RPC required the launch bearer; invalid and previous-launch bearers returned `UNAUTHENTICATED`. A shorter deadline on a delayed generated provider call returned `DEADLINE_EXCEEDED`, and the subprocess remained healthy afterward.

After `SIGTERM`, the child closed cleanly, removed its socket, and exited zero. A new process rebound the same socket path with a new bearer, completed health and provider calls, and left the runtime directory empty after termination. The fixture used only compiled and per-launch input, so the exercised behavior required no plugin-owned durable state.

This result validates the selected transport and lifecycle primitives on the MVP production and development operating systems. It does not implement or validate the Milestone 3 supervisor, bounded restart policy, crash-loop handling, resource limits, stderr integration, provider connectivity, Jellyfin behavior, credential persistence, schedules, or container packaging.
```

Do not record temporary directory names, socket values, fixture references, bearer values, captured errors, or full test output.

- [ ] **Step 3: Commit the durable evidence**

```bash
git add docs/architecture/plugin-system.md
git commit -m "docs(plugin): record IPC spike evidence" -m "Refs #17"
```

### Task 4: Retire the disposable spike and verify the repository

**Files:**
- Delete: `apps/server/src/plugin-ipc-child.ts`
- Delete: `apps/server/src/plugin-ipc-lifecycle.ts`
- Delete: `apps/server/src/plugin-ipc-lifecycle.test.ts`
- Restore: `apps/server/package.json`
- Restore: `pnpm-lock.yaml`
- Verify: `docs/architecture/plugin-system.md`

**Interfaces:**
- Consumes: passing macOS and Linux evidence from Tasks 2–3.
- Produces: a final tree with no spike executable, test, production supervisor, or spike-only dependency.

- [ ] **Step 1: Remove temporary dependencies through pnpm**

Run:

```bash
pnpm --filter @nama/server remove @connectrpc/connect @connectrpc/connect-node
```

Then verify package and lock state match the approved-design commit baseline:

```bash
git diff --exit-code f1ebaf6 -- apps/server/package.json pnpm-lock.yaml
```

Expected: both commands exit 0. If pnpm leaves ordering-only drift, restore only these two spike-owned files to `f1ebaf6` and repeat the comparison.

- [ ] **Step 2: Delete the three disposable source files**

Delete only:

```text
apps/server/src/plugin-ipc-child.ts
apps/server/src/plugin-ipc-lifecycle.ts
apps/server/src/plugin-ipc-lifecycle.test.ts
```

Confirm no remaining handwritten source imports `@connectrpc/connect`, `@connectrpc/connect-node`, or `plugin-ipc-`.

- [ ] **Step 3: Run the owning narrow check on the retired tree**

Run:

```bash
mise run check:ts
```

Expected: formatting, lint, TypeScript compilation, and handwritten contract tests all pass.

- [ ] **Step 4: Run the complete repository check**

Run:

```bash
mise run check
```

Expected: contract generation drift, TypeScript, Go, and Docker model checks all pass. Report any unavailable local prerequisite exactly; do not weaken or skip its row.

- [ ] **Step 5: Commit retirement**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/plugin-ipc-child.ts apps/server/src/plugin-ipc-lifecycle.ts apps/server/src/plugin-ipc-lifecycle.test.ts
git commit -m "chore(server): retire plugin IPC spike" -m "Refs #17"
```

The final branch must retain the approved design, this plan, and `docs/architecture/plugin-system.md` evidence while containing no executable spike code or spike-only dependency.