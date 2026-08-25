// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/prefer-destructuring, typescript/no-unsafe-type-assertion -- This executable authorization flow keeps device polling, CLI approval, JWT access, refresh rotation, and broad revocation in one ordered real-process scenario.
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { LibraryService } from "@nama/api/nama/api/v1/library_pb.js";
import { Duration, Effect } from "effect";

import {
  completeAdministratorSetup,
  signInAdministrator,
  startAuthenticationFlow,
} from "./authentication-flow.test-support.ts";
import type { AuthenticationScenario } from "./authentication-flow.test-support.ts";
import {
  callOptions,
  expectApplicationFailure,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import {
  cliEnvironment,
  createNamaRunner,
  dataFromNama,
  withNamaBinary,
} from "./compiled-cli.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const INTEGRATION_TIMEOUT_MILLISECONDS = 30_000;
const APPLE_CLIENT_ID = "nama-apple";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const AUTHORIZATION_SCOPE = "nama:library nama:playback nama:user-state offline_access";
const CONSUMER_SCOPE = "nama:library nama:playback nama:user-state";
const ADMINISTRATOR_EMAIL = "administrator@oauth-flow.test";
const ADMINISTRATOR_PASSWORD = "administrator-password-for-oauth-flow";
const SIGNED_BEARER_PATTERN = /^[A-Za-z0-9]{32}\.[A-Za-z0-9+/]{43}=$/u;

interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly expires_in: number;
  readonly interval: number;
}

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly scope: string;
  readonly token_type: string;
}

interface OAuthErrorResponse {
  readonly error: string;
}

interface AuthorizationServerMetadata {
  readonly device_authorization_endpoint: string;
  readonly issuer: string;
  readonly jwks_uri: string;
  readonly revocation_endpoint: string;
  readonly token_endpoint: string;
}

interface AccessTokenClaims {
  readonly aud: string | string[];
  readonly client_id: string;
  readonly exp: number;
  readonly iss: string;
  readonly scope: string;
  readonly sub: string;
}

interface ProtectedResourceMetadata {
  readonly authorization_servers: string[];
  readonly resource: string;
  readonly scopes_supported: string[];
}

const scenario = (databaseUrl: string): AuthenticationScenario => ({
  databaseUrl,
  displayName: "OAuth Flow Administrator",
  email: ADMINISTRATOR_EMAIL,
  invalidSetupFieldViolations: [],
  password: ADMINISTRATOR_PASSWORD,
  signedBearerPattern: SIGNED_BEARER_PATTERN,
  startupSensitiveValues: [ADMINISTRATOR_PASSWORD],
  unknownEmail: "unknown@oauth-flow.test",
  wrongBootstrapToken: "wrong-bootstrap-token",
  wrongPassword: "wrong-password-for-oauth-flow",
});

const readJson = async <Value>(response: Response): Promise<Value> =>
  (await response.json()) as Value;

const postForm = (url: string, fields: Readonly<Record<string, string>>) =>
  fetch(url, {
    body: new URLSearchParams(fields),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });

const accessTokenClaims = (token: string): AccessTokenClaims => {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    throw new Error("access token payload is missing");
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
};

it.live(
  "completes Better Auth device authorization, scoped access, refresh, and broad revocation",
  () =>
    withNamaBinary(({ binary, home }) =>
      withIsolatedDatabase((databaseUrl) =>
        Effect.acquireUseRelease(
          startAuthenticationFlow(scenario(databaseUrl)),
          (flow) =>
            Effect.gen(function* oauthDeviceFlowTest() {
              const configured = yield* completeAdministratorSetup(flow);
              const session = yield* signInAdministrator(
                flow,
                configured.expectedAdministrator,
                "OAuth flow SignIn",
              );
              const nama = createNamaRunner(binary, cliEnvironment(home, session.token));

              const authorizationMetadataResponse = yield* Effect.promise(() =>
                fetch(`${flow.runningProcess.origin}/.well-known/oauth-authorization-server`, {
                  redirect: "manual",
                }),
              );
              expect(authorizationMetadataResponse.status).toBe(200);
              const metadata = yield* Effect.promise(() =>
                readJson<AuthorizationServerMetadata>(authorizationMetadataResponse),
              );
              expect(metadata.issuer).not.toBe("");
              expect(metadata.device_authorization_endpoint).toBe(`${metadata.issuer}/device/code`);
              expect(metadata.token_endpoint).toBe(`${metadata.issuer}/oauth2/token`);
              expect(metadata.revocation_endpoint).toBe(`${metadata.issuer}/oauth2/revoke`);
              expect(metadata.jwks_uri).toBe(`${metadata.issuer}/jwks`);

              const protectedMetadataResponse = yield* Effect.promise(() =>
                fetch(`${flow.runningProcess.origin}/.well-known/oauth-protected-resource`, {
                  redirect: "manual",
                }),
              );
              expect(protectedMetadataResponse.status).toBe(200);
              const protectedMetadata = yield* Effect.promise(() =>
                readJson<ProtectedResourceMetadata>(protectedMetadataResponse),
              );
              expect(protectedMetadata).toEqual({
                authorization_servers: [metadata.issuer],
                resource: `${metadata.issuer}/`,
                scopes_supported: ["nama:library", "nama:playback", "nama:user-state"],
              });
              const { resource } = protectedMetadata;

              const deviceResponse = yield* Effect.promise(() =>
                postForm(`${flow.runningProcess.origin}/device/code`, {
                  client_id: APPLE_CLIENT_ID,
                  resource,
                  scope: AUTHORIZATION_SCOPE,
                }),
              );
              expect(deviceResponse.status).toBe(200);
              const device = yield* Effect.promise(() =>
                readJson<DeviceAuthorizationResponse>(deviceResponse),
              );
              expect(device.device_code).not.toBe("");
              expect(device.user_code).not.toBe("");
              expect(device.expires_in).toBeGreaterThan(0);
              expect(device.interval).toBeGreaterThan(0);
              expect(device.verification_uri).toBe(`${metadata.issuer}/device`);

              yield* Effect.sleep(Duration.seconds(device.interval));
              const pendingResponse = yield* Effect.promise(() =>
                postForm(`${flow.runningProcess.origin}/oauth2/token`, {
                  client_id: APPLE_CLIENT_ID,
                  device_code: device.device_code,
                  grant_type: DEVICE_CODE_GRANT,
                  resource,
                }),
              );
              expect(pendingResponse.status).toBe(400);
              expect(
                yield* Effect.promise(() => readJson<OAuthErrorResponse>(pendingResponse)),
              ).toMatchObject({ error: "authorization_pending" });

              yield* expectApplicationFailure({
                expectedCode: Code.InvalidArgument,
                expectedReason: "DEVICE_AUTHORIZATION_CODE_INVALID",
                invoke: () =>
                  flow.clients.authentication.approveDeviceAuthorization(
                    { userCode: "WRONG-CODE" },
                    callOptions(session.authorization),
                  ),
                publicErrors: flow.publicErrors,
              });
              yield* expectApplicationFailure({
                expectedCode: Code.Unauthenticated,
                expectedReason: "CREDENTIAL_INVALID",
                invoke: () =>
                  flow.clients.authentication.approveDeviceAuthorization(
                    { userCode: device.user_code },
                    callOptions(),
                  ),
                publicErrors: flow.publicErrors,
              });
              const approval = yield* nama([
                "auth",
                "approve-device",
                device.user_code,
                "--server",
                flow.runningProcess.origin,
                "--output",
                "json",
              ]);
              expect(approval).toMatchObject({ exitCode: 0, stderr: "" });
              expect(dataFromNama(approval)).toMatchObject({ approved: true });

              yield* Effect.sleep(Duration.seconds(device.interval));
              const tokenResponse = yield* Effect.promise(() =>
                postForm(`${flow.runningProcess.origin}/oauth2/token`, {
                  client_id: APPLE_CLIENT_ID,
                  device_code: device.device_code,
                  grant_type: DEVICE_CODE_GRANT,
                  resource,
                }),
              );
              if (tokenResponse.status !== 200) {
                const failure = yield* Effect.promise(() =>
                  readJson<OAuthErrorResponse>(tokenResponse),
                );
                throw new Error(
                  `token exchange failed with ${tokenResponse.status} ${failure.error}`,
                );
              }
              const token = yield* Effect.promise(() => readJson<TokenResponse>(tokenResponse));
              expect(token.access_token.split(".")).toHaveLength(3);
              expect(token.refresh_token).not.toBe("");
              expect(token.expires_in).toBe(3600);
              expect(token.scope.split(/\s+/u).toSorted()).toEqual(
                CONSUMER_SCOPE.split(" ").toSorted(),
              );
              expect(token.token_type.toLowerCase()).toBe("bearer");
              const claims = accessTokenClaims(token.access_token);
              expect(claims).toMatchObject({
                aud: resource,
                client_id: APPLE_CLIENT_ID,
                iss: metadata.issuer,
                scope: CONSUMER_SCOPE,
              });
              expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
              expect(claims.sub).not.toBe("");

              const transport = createConnectTransport({
                baseUrl: flow.runningProcess.origin,
                httpVersion: "1.1",
              });
              const library = createClient(LibraryService, transport);
              yield* Effect.promise(() =>
                library.getHome({}, callOptions(`Bearer ${token.access_token}`)),
              );
              yield* expectApplicationFailure({
                expectedCode: Code.Unauthenticated,
                expectedReason: "CREDENTIAL_INVALID",
                invoke: () =>
                  flow.clients.authentication.getCurrentUser(
                    {},
                    callOptions(`Bearer ${token.access_token}`),
                  ),
                publicErrors: flow.publicErrors,
              });

              const refreshResponse = yield* Effect.promise(() =>
                postForm(`${flow.runningProcess.origin}/oauth2/token`, {
                  client_id: APPLE_CLIENT_ID,
                  grant_type: "refresh_token",
                  refresh_token: token.refresh_token,
                  resource,
                }),
              );
              expect(refreshResponse.status).toBe(200);
              const refreshed = yield* Effect.promise(() =>
                readJson<TokenResponse>(refreshResponse),
              );
              expect(refreshed.access_token).not.toBe(token.access_token);
              expect(refreshed.refresh_token).not.toBe("");

              const revocation = yield* nama([
                "auth",
                "revoke-apple-client",
                "--yes",
                "--server",
                flow.runningProcess.origin,
                "--output",
                "json",
              ]);
              expect(revocation).toMatchObject({ exitCode: 0, stderr: "" });
              expect(dataFromNama(revocation)).toMatchObject({ revoked: true });
              const revokedRefreshResponse = yield* Effect.promise(() =>
                postForm(`${flow.runningProcess.origin}/oauth2/token`, {
                  client_id: APPLE_CLIENT_ID,
                  grant_type: "refresh_token",
                  refresh_token: refreshed.refresh_token,
                  resource,
                }),
              );
              expect(revokedRefreshResponse.status).toBe(400);
              expect(
                yield* Effect.promise(() => readJson<OAuthErrorResponse>(revokedRefreshResponse)),
              ).toMatchObject({ error: "invalid_grant" });
              yield* Effect.promise(() =>
                library.getHome({}, callOptions(`Bearer ${refreshed.access_token}`)),
              );
            }),
          (flow) => stopCleanly(flow.runningProcess),
        ),
      ),
    ),
  INTEGRATION_TIMEOUT_MILLISECONDS,
);
