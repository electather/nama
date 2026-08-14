# Better Auth Connect Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove administrator setup and a complete Better Auth session lifecycle exclusively through Nama's existing Connect RPC contract, including fail-closed behavior when session deletion fails.

**Architecture:** A disposable loopback Node Connect server registers only `SetupService` and `AuthService`. One private module owns Better Auth, its signed bearer plugin, and the official stateful memory adapter; a Connect interceptor maps authenticated sessions to a Nama administrator, and sign-out succeeds only after a post-delete session lookup proves revocation.

**Tech Stack:** Node.js 24, strict TypeScript, Node test runner, Connect ES 2.1.2, Better Auth 1.6.26, generated `nama.api.v1` descriptors.

## Global Constraints

- Add only the approved exact runtime dependencies: `better-auth@1.6.26`, `@connectrpc/connect@2.1.2`, and `@connectrpc/connect-node@2.1.2`.
- Do not change `proto/` or `gen/`; the existing public Setup/Auth contract is sufficient.
- No Better Auth type, route, cookie, raw error, session token, or adapter value may cross the private module boundary.
- Do not add PostgreSQL, Effect, Drizzle, migrations, production configuration, CLI behavior, or another M1 spike.
- `SignOut` returns success only after the presented bearer no longer resolves; otherwise return `UNAVAILABLE` and `SESSION_REVOCATION_UNCONFIRMED`.
- Never log or return bootstrap tokens, passwords, bearer tokens, Better Auth errors, or adapter errors.
- The official memory adapter is disposable test evidence, not PostgreSQL or restart-durability proof.

---

### Task 1: Pin dependencies and write the failing flow

**Files:**
- Modify: `apps/server/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/server/src/auth-spike.test.ts`

**Interfaces:**
- Consumes: existing generated `SetupService`, `AuthService`, and `ErrorInfoSchema` exports.
- Produces: the required `startAuthSpikeServer(options): Promise<AuthSpikeServer>` contract that Task 2 implements.

- [ ] **Step 1: Add only the approved exact dependencies**

Run:

```bash
pnpm --filter @nama/server add --save-exact better-auth@1.6.26 @connectrpc/connect@2.1.2 @connectrpc/connect-node@2.1.2
```

Change the server's existing test script so the owning TypeScript check discovers every focused test:

```json
"check:contract": "node --test src/*.test.ts"
```

- [ ] **Step 2: Write the complete failing behavioral test**

Create `apps/server/src/auth-spike.test.ts` with one actual generated-client flow. The test uses only opaque strings outside the private implementation and controls the delete fault through a boolean callback:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";

import { startAuthSpikeServer } from "./auth-spike.ts";

void test("Better Auth stays behind Nama RPCs and sign-out is confirmed", async (context) => {
  const bootstrapToken = "bootstrap-secret-not-for-logs";
  const password = "administrator-password-not-for-logs";
  let failSessionDeletion = false;
  const server = await startAuthSpikeServer({
    authSecret: "0123456789abcdef0123456789abcdef",
    bootstrapToken,
    failSessionDeletion: () => failSessionDeletion,
  });
  context.after(() => server.close());

  const transport = createConnectTransport({
    baseUrl: server.baseUrl,
    httpVersion: "1.1",
  });
  const setup = createClient(SetupService, transport);
  const auth = createClient(AuthService, transport);

  const privateRoute = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password }),
  });
  assert.equal(privateRoute.status, 404);

  const created = await setup.createAdministrator({
    bootstrapToken,
    displayName: "Nama Administrator",
    email: "admin@example.com",
    password,
  });
  assert.ok(created.administrator);
  assert.equal(created.administrator.displayName, "Nama Administrator");
  assert.equal(created.administrator.email, "admin@example.com");

  const signedIn = await auth.signIn({
    email: "admin@example.com",
    password,
  });
  assert.ok(signedIn.credential);
  const token = signedIn.credential.token;
  const headers = { authorization: `Bearer ${token}` };

  const current = await auth.getCurrentUser({}, { headers });
  assert.deepEqual(current.administrator, signedIn.administrator);

  failSessionDeletion = true;
  await assert.rejects(auth.signOut({}, { headers }), (failure: unknown) => {
    const error = ConnectError.from(failure);
    assert.equal(error.code, Code.Unavailable);
    assert.deepEqual(
      error.findDetails(ErrorInfoSchema).map((detail) => detail.reason),
      ["SESSION_REVOCATION_UNCONFIRMED"],
    );
    for (const secret of [bootstrapToken, password, token]) {
      assert.equal(error.message.includes(secret), false);
    }
    return true;
  });

  const stillCurrent = await auth.getCurrentUser({}, { headers });
  assert.deepEqual(stillCurrent.administrator, signedIn.administrator);

  failSessionDeletion = false;
  await auth.signOut({}, { headers });
  await assert.rejects(auth.getCurrentUser({}, { headers }), (failure: unknown) => {
    const error = ConnectError.from(failure);
    assert.equal(error.code, Code.Unauthenticated);
    assert.deepEqual(
      error.findDetails(ErrorInfoSchema).map((detail) => detail.reason),
      ["CREDENTIAL_INVALID"],
    );
    return true;
  });
});
```


- [ ] **Step 3: Run the focused test and verify the intended failure**

Run:

```bash
pnpm --filter @nama/server exec node --test src/auth-spike.test.ts
```

Expected: failure loading `./auth-spike.ts` because the private spike server has not been implemented. A pass, skip, or unrelated dependency failure is not the required red state.

- [ ] **Step 4: Commit the red behavioral contract**

```bash
git add apps/server/package.json pnpm-lock.yaml apps/server/src/auth-spike.test.ts
git commit -m "test(auth): define Better Auth RPC proof"
```

### Task 2: Implement the private Better Auth Connect boundary

**Files:**
- Create: `apps/server/src/auth-spike.ts`
- Test: `apps/server/src/auth-spike.test.ts`

**Interfaces:**
- Consumes: `contractAuthorityByMethod` for the existing default-deny method inventory and the generated Setup/Auth service descriptors.
- Produces:

```ts
export interface AuthSpikeOptions {
  readonly authSecret: string;
  readonly bootstrapToken: string;
  readonly failSessionDeletion: () => boolean;
}

export interface AuthSpikeServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function startAuthSpikeServer(
  options: AuthSpikeOptions,
): Promise<AuthSpikeServer>;
```

No exported signature references Better Auth.

- [ ] **Step 1: Build the faultable private adapter and safe error mapper**

Inside `auth-spike.ts`, import Better Auth only here. Back it with `MemoryDB` tables for `user`, `session`, `account`, and `verification`. Wrap the adapter's `delete` method and throw a static private error only for model `session` while `failSessionDeletion()` is true:

```ts
const memoryDatabase: MemoryDB = {
  account: [],
  session: [],
  user: [],
  verification: [],
};
const createMemoryAdapter = memoryAdapter(memoryDatabase);

const auth = betterAuth({
  baseURL: "http://127.0.0.1",
  secret: options.authSecret,
  database: (authOptions) => {
    const adapter = createMemoryAdapter(authOptions);
    return {
      ...adapter,
      async delete(input) {
        if (input.model === "session" && options.failSessionDeletion()) {
          throw new Error("injected session deletion failure");
        }
        await adapter.delete(input);
      },
    };
  },
  emailAndPassword: { enabled: true, autoSignIn: false },
  logger: { disabled: true },
  plugins: [bearer({ requireSignature: true })],
});
```

Create one safe Connect error helper. Every public failure uses `ErrorInfoSchema` with domain `nama.api.v1`; never interpolate a caught error or secret:

```ts
function publicError(code: Code, reason: string, message: string): ConnectError {
  return new ConnectError(message, code, undefined, [
    { desc: ErrorInfoSchema, value: { domain: "nama.api.v1", reason } },
  ]);
}
```

Store only `SHA-256(bootstrapToken)` and compare the presented token with `timingSafeEqual`. Map Better Auth users through a private `toAdministrator()` helper returning only `{ id, displayName: user.name, email: user.email }`.

- [ ] **Step 2: Add the default-deny authentication interceptor**

Create a context key for the Nama administrator shape. Build the fully qualified method name from `request.service.typeName` and `request.method.name`, look it up in `contractAuthorityByMethod`, and authenticate only methods whose authority is `administrator`:

```ts
const administratorKey = createContextKey<Administrator | undefined>(undefined);

const authenticate: Interceptor = (next) => async (request) => {
  const method = `${request.service.typeName}.${request.method.name}`;
  if (Reflect.get(contractAuthorityByMethod, method) !== "administrator") {
    return next(request);
  }
  const session = await resolveSession(request.header);
  request.contextValues.set(administratorKey, toAdministrator(session.user));
  return next(request);
};
```

`resolveSession(headers)` calls `auth.api.getSession({ headers })`. A null session returns `UNAUTHENTICATED/CREDENTIAL_INVALID`; an unexpected private failure returns a generic `INTERNAL/INTERNAL` without the private cause.

- [ ] **Step 3: Register Nama-owned setup and authentication handlers**

Use `connectNodeAdapter({ interceptors: [authenticate], routes })` and a native `node:http` listener bound to `127.0.0.1` on port `0`.

Handler rules:

- `GetStatus` returns the in-process initialized flag.
- `CreateAdministrator` rejects an invalid bootstrap digest as `UNAUTHENTICATED/AUTHENTICATION_FAILED`, rejects reuse as `FAILED_PRECONDITION/ALREADY_INITIALIZED`, calls `auth.api.signUpEmail`, marks initialized only after user creation, and returns the mapped administrator.
- `SignIn` calls `auth.api.signInEmail({ body, returnHeaders: true })`, extracts only `set-auth-token`, resolves that bearer once to obtain the authoritative session expiry, and returns the mapped administrator plus a generated timestamp initializer.
- `GetCurrentUser` returns only `context.values.get(administratorKey)` and fails closed if absent.
- `SignOut` calls `auth.api.signOut({ headers: context.requestHeader })`, ignores its boolean as non-authoritative, then calls `auth.api.getSession` with the same header. Return `{}` only for a null session. A remaining session or failed confirmation becomes `UNAVAILABLE/SESSION_REVOCATION_UNCONFIRMED`.

The timestamp initializer is derived without exposing a Better Auth value:

```ts
function timestamp(date: Date) {
  const milliseconds = date.getTime();
  return {
    seconds: BigInt(Math.floor(milliseconds / 1_000)),
    nanos: (milliseconds % 1_000) * 1_000_000,
  };
}
```

Do not mount `auth.handler`; unknown `/api/auth/*` paths must remain 404.

- [ ] **Step 4: Run the focused proof and make it green**

Run:

```bash
pnpm --filter @nama/server exec node --test src/auth-spike.test.ts
```

Expected: one passing test. The forced deletion call returns `UNAVAILABLE`, the still-valid bearer authenticates afterward, the retry succeeds after fault removal, and the revoked bearer is then `UNAUTHENTICATED`.

- [ ] **Step 5: Run the owning TypeScript check**

Run:

```bash
mise run check:ts
```

Expected: format, lint, strict typecheck, the existing contract checks, and the new auth flow all pass.

- [ ] **Step 6: Commit the implementation**

```bash
git add apps/server/src/auth-spike.ts apps/server/src/auth-spike.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "feat(auth): prove Better Auth behind Connect"
```

### Task 3: Record evidence and verify the repository

**Files:**
- Modify: `docs/architecture/authentication-and-setup.md`
- Test: `apps/server/src/auth-spike.test.ts`

**Interfaces:**
- Consumes: the passing behavioral proof from Task 2.
- Produces: durable architecture evidence for issue #18 and exact verification output.

- [ ] **Step 1: Add the durable spike result to the authentication note**

Append a concise `## Milestone 1 Better Auth Connect spike` section recording:

- Better Auth `1.6.26` was exercised only behind generated Nama Connect clients; no Better Auth route was mounted.
- `SignIn` must extract the signed `set-auth-token` emitted by the bearer plugin and Nama must use it only as `BearerCredential.token`.
- Better Auth `1.6.26` catches `deleteSession()` failures and still returns `{ success: true }`; Nama therefore performs an authoritative post-sign-out session lookup.
- A still-valid or unconfirmable bearer maps to `UNAVAILABLE` and `SESSION_REVOCATION_UNCONFIRMED`; only an absent session maps to successful sign-out.
- The focused test command is `pnpm --filter @nama/server exec node --test src/auth-spike.test.ts`.
- The official stateful memory adapter proves translation and failure semantics only. PostgreSQL migrations, durable initialization, restart repair, production logging, and runtime lifecycle remain Milestone 2 work.

- [ ] **Step 2: Re-run the focused behavioral proof**

Run:

```bash
pnpm --filter @nama/server exec node --test src/auth-spike.test.ts
```

Expected: one passing test after the documentation-only change.

- [ ] **Step 3: Run the complete repository check**

Run:

```bash
mise run check
```

Expected: contract drift/lint/build, all handwritten TypeScript checks, Go checks, and Docker Compose validation pass. Report any unavailable local prerequisite exactly; do not weaken or replace a required row.

- [ ] **Step 4: Commit the durable evidence**

```bash
git add docs/architecture/authentication-and-setup.md
git commit -m "docs(auth): record Better Auth spike evidence" -m "Refs #18"
```

- [ ] **Step 5: Final scope audit**

Confirm the changed implementation surface is limited to the approved dependencies, the two auth spike files, test discovery, the approved spec/plan, and the authentication architecture evidence. Confirm `proto/`, `gen/`, CLI, plugin, and other spike files are unchanged. Final delivery lists files changed, exact commands and results, and any blockers or unanswered questions.
