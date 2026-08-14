// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/sort-imports, typescript/prefer-readonly-parameter-types -- One serialized integration flow must preserve the same bearer across the ambiguous sign-out boundary.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";

import { startAuthSpikeServer } from "./auth-spike.ts";

const HTTP_NOT_FOUND = 404;
const SINGLE_ADMINISTRATOR = 1;

void test("Nama confirms Better Auth session revocation", async (context) => {
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
    body: JSON.stringify({ email: "admin@example.com", password }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  assert.equal(privateRoute.status, HTTP_NOT_FOUND);

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
  assert.ok(signedIn.credential.expiresAt);
  const { token } = signedIn.credential;
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

void test("bootstrap token creates only one administrator", async (context) => {
  const password = "administrator-password-not-for-logs";
  const server = await startAuthSpikeServer({
    authSecret: "fedcba9876543210fedcba9876543210",
    bootstrapToken: "single-use-bootstrap-token",
    failSessionDeletion: () => false,
  });
  context.after(() => server.close());

  const transport = createConnectTransport({
    baseUrl: server.baseUrl,
    httpVersion: "1.1",
  });
  const setup = createClient(SetupService, transport);
  const auth = createClient(AuthService, transport);
  const attempts = [
    {
      bootstrapToken: "single-use-bootstrap-token",
      displayName: "First Administrator",
      email: "first@example.com",
      password,
    },
    {
      bootstrapToken: "single-use-bootstrap-token",
      displayName: "Second Administrator",
      email: "second@example.com",
      password,
    },
  ] as const;

  const results = await Promise.allSettled(
    attempts.map((attempt) => setup.createAdministrator(attempt)),
  );
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, SINGLE_ADMINISTRATOR);
  assert.equal(rejected.length, SINGLE_ADMINISTRATOR);

  const [failedSetup] = rejected;
  assert.ok(failedSetup);
  const setupError = ConnectError.from(failedSetup.reason);
  assert.equal(setupError.code, Code.FailedPrecondition);
  assert.deepEqual(
    setupError.findDetails(ErrorInfoSchema).map((detail) => detail.reason),
    ["ALREADY_INITIALIZED"],
  );

  const [successfulSetup] = fulfilled;
  assert.ok(successfulSetup);
  const winningEmail = successfulSetup.value.administrator?.email;
  if (winningEmail === undefined) {
    assert.fail("successful setup did not return an administrator email");
  }
  const losingAttempt = attempts.find((attempt) => attempt.email !== winningEmail);
  assert.ok(losingAttempt);
  await assert.rejects(
    auth.signIn({ email: losingAttempt.email, password }),
    (failure: unknown) => ConnectError.from(failure).code === Code.Unauthenticated,
  );
});
