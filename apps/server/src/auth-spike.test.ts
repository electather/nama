import assert from "node:assert/strict";
import { test } from "node:test";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";

import { startAuthSpikeServer } from "./auth-spike.ts";

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
  assert.ok(signedIn.credential.expiresAt);
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
