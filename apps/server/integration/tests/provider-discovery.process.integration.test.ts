// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary, eslint/prefer-destructuring, eslint/sort-keys, promise/avoid-new, promise/prefer-await-to-callbacks, typescript/consistent-return, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/strict-boolean-expressions, typescript/strict-void-return -- This executable flow keeps the CLI, server, PostgreSQL, subprocess, controlled HTTP provider, and exact process streams visible in one scenario.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { HealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import { Effect, Exit, Scope } from "effect";
import { Pool } from "pg";

import type {
  ProviderInstanceRecord,
  ProviderPersistence,
} from "../../src/database/provider-persistence.ts";
import { unusedProviderPersistence } from "../../src/database/tests/provider-persistence.test-support.ts";
import {
  createTestConnectRequestListener,
  withEphemeralServer,
} from "../../src/http/tests/connect-dispatch.test-support.ts";
import { makeProviderDeleteTestManagement } from "../../src/http/tests/provider-delete-runtime.test-support.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";
import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { MASTER_KEY, startProcess } from "./process.test-support.ts";

const execFilePromise = promisify(execFile);
const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
const PLUGIN_FIXTURE_PATH = join(import.meta.dirname, "fixtures/plugin-subprocess.mjs");
const PLUGIN_CALL_DEADLINE_MILLISECONDS = 1000;
const ABSENT_RESULT_BY_KEY: Readonly<Record<string, undefined>> = Object.freeze({});
const NO_OPERATION_RESULT = Effect.sync(() => ABSENT_RESULT_BY_KEY["operation"]);
const PLUGIN_SUPERVISOR_LAYER = PluginSupervisor.layer();
const TEST_TIMEOUT_MILLISECONDS = 30_000;
const ADMINISTRATOR = Object.freeze({
  displayName: "Provider Discovery Administrator",
  email: "provider-discovery@example.test",
  password: "provider-discovery-password",
});

interface NamaResult {
  readonly stderr: string;
  readonly stdout: string;
}
interface NamaFailureResult extends NamaResult {
  readonly exitCode: number;
}

const requiredString = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new TypeError("expected string value");
  }
  return value;
};
const providerInstanceFromNamaResult = (result: NamaResult): Readonly<Record<string, unknown>> => {
  const responsePayload: unknown = JSON.parse(result.stdout);
  if (
    typeof responsePayload !== "object" ||
    responsePayload === null ||
    !("data" in responsePayload) ||
    typeof responsePayload.data !== "object" ||
    responsePayload.data === null ||
    !("provider_instance" in responsePayload.data) ||
    typeof responsePayload.data.provider_instance !== "object" ||
    responsePayload.data.provider_instance === null
  ) {
    throw new TypeError("expected a provider-instance mutation response");
  }
  return responsePayload.data.provider_instance as Readonly<Record<string, unknown>>;
};

const withNamaBinary = <Success, Failure, Requirements>(
  use: (
    input: Readonly<{ binary: string; home: string }>,
  ) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await mkdtemp(join(tmpdir(), "nama-provider-discovery-"));
      const binary = join(directory, "nama");
      await execFilePromise("go", ["build", "-o", binary, "./apps/cli/cmd/nama"], {
        cwd: REPOSITORY_ROOT,
      });
      return { binary, directory, home: join(directory, "home") };
    }),
    use,
    ({ directory }) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
  );

const cliEnvironment = (home: string, token: string): NodeJS.ProcessEnv => {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("NAMA_")),
  );
  return {
    ...environment,
    APPDATA: home,
    HOME: home,
    NAMA_TOKEN: token,
    XDG_CONFIG_HOME: home,
  };
};

const runNama = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): Effect.Effect<NamaResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: async () => {
      const result = await execFilePromise(binary, arguments_, {
        cwd: REPOSITORY_ROOT,
        env: environment,
      });
      return { stderr: result.stderr, stdout: result.stdout };
    },
  });
const runNamaWithInput = ({
  binary,
  environment,
  arguments_,
  input,
}: Readonly<{
  readonly binary: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly arguments_: readonly string[];
  readonly input: string;
}>): Effect.Effect<NamaResult, unknown> =>
  Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      new Promise<NamaResult>((resolve, reject) => {
        const child = spawn(binary, arguments_, {
          cwd: REPOSITORY_ROOT,
          env: environment,
          stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.once("error", reject);
        child.once("close", (code) => {
          const result = {
            stderr: Buffer.concat(stderr).toString("utf8"),
            stdout: Buffer.concat(stdout).toString("utf8"),
          };
          if (code === 0) {
            resolve(result);
          } else {
            reject(new Error(`nama exited ${String(code)}: ${result.stderr}`));
          }
        });
        child.stdin.end(input);
      }),
  });

const runNamaFailure = (
  binary: string,
  environment: NodeJS.ProcessEnv,
  arguments_: readonly string[],
): Effect.Effect<NamaFailureResult> =>
  Effect.promise(async () => {
    try {
      await execFilePromise(binary, arguments_, {
        cwd: REPOSITORY_ROOT,
        env: environment,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null) {
        const code = Reflect.get(error, "code");
        const stderr = Reflect.get(error, "stderr");
        const stdout = Reflect.get(error, "stdout");
        if (typeof code === "number" && typeof stderr === "string" && typeof stdout === "string") {
          return { exitCode: code, stderr, stdout };
        }
      }
      throw error;
    }
    throw new Error("nama command unexpectedly succeeded");
  });
const expectNamaFailure = (result: NamaFailureResult, exitCode: number, code: string): void => {
  expect(result.exitCode).toBe(exitCode);
  expect(result.stdout).toBe("");
  const payload: unknown = JSON.parse(result.stderr);
  expect(payload).toMatchObject({ error: { code } });
  expect(result.stderr).not.toContain("provider-api-key-sentinel");
};

const withControlledJellyfin = <Success, Failure, Requirements>(
  use: (
    fixture: Readonly<{ readonly baseUrl: string; readonly requestCount: () => number }>,
  ) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<
          Readonly<{
            readonly baseUrl: string;
            readonly requestCount: () => number;
            readonly server: Server;
          }>
        >((resolve, reject) => {
          let requestCount = 0;
          const server = createServer((request, response) => {
            requestCount += 1;
            if (request.url === "/System/Info/Public") {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  Id: "provider-server-id",
                  ServerName: "Provider Test Jellyfin",
                  Version: "10.11.0",
                }),
              );
              return;
            }
            const authorization = request.headers.authorization;
            const userId = request.url?.startsWith("/Users/")
              ? request.url.slice("/Users/".length)
              : undefined;
            if (
              userId !== undefined &&
              (authorization === 'MediaBrowser Token="provider-api-key-sentinel"' ||
                authorization === 'MediaBrowser Token="replacement-provider-api-key-sentinel"')
            ) {
              response.setHeader("content-type", "application/json");
              response.end(
                JSON.stringify({
                  Id: userId === "mismatch-user" ? "another-user" : userId,
                  Policy: { IsDisabled: userId === "disabled-user" },
                  ServerId: "provider-server-id",
                }),
              );
              return;
            }
            response.statusCode = 401;
            response.end();
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address() as AddressInfo;
            resolve({
              baseUrl: `http://127.0.0.1:${address.port}`,
              requestCount: () => requestCount,
              server,
            });
          });
        }),
    ),
    ({ baseUrl, requestCount }) => use({ baseUrl, requestCount }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error === undefined) {
                resolve();
              } else {
                reject(error);
              }
            });
          }),
      ),
  );

it.live(
  "lists production-reconciled Jellyfin provider metadata through the compiled CLI",
  () =>
    withControlledJellyfin(({ baseUrl: jellyfinBaseUrl, requestCount }) =>
      withIsolatedDatabase((databaseUrl) =>
        withNamaBinary(({ binary, home }) =>
          Effect.gen(function* providerDiscoveryProcessTest() {
            const runningProcess = yield* startProcess(databaseUrl);
            yield* expectReady(runningProcess);
            const clients = clientsFor(runningProcess.origin);
            const providerClient = createClient(
              ProviderService,
              createConnectTransport({
                baseUrl: runningProcess.origin,
                httpVersion: "1.1",
              }),
            );
            yield* expectRpcSuccess({
              invoke: () =>
                clients.setup.createAdministrator(
                  {
                    bootstrapToken: bootstrapTokenFrom(runningProcess),
                    displayName: ADMINISTRATOR.displayName,
                    email: ADMINISTRATOR.email,
                    password: ADMINISTRATOR.password,
                  },
                  callOptions(),
                ),
              phase: "CreateAdministrator",
            });
            const signIn = yield* expectRpcSuccess({
              invoke: () =>
                clients.authentication.signIn(
                  { email: ADMINISTRATOR.email, password: ADMINISTRATOR.password },
                  callOptions(),
                ),
              phase: "SignIn",
            });
            const token = signIn.credential?.token;
            if (token === undefined || token.length === 0) {
              return yield* Effect.die(new Error("expected a signed administrator credential"));
            }
            const environment = cliEnvironment(home, token);
            yield* runNama(binary, environment, [
              "profile",
              "set",
              "local",
              "--server",
              runningProcess.origin,
              "--output",
              "json",
            ]);

            const human = yield* runNama(binary, environment, [
              "provider",
              "type",
              "list",
              "--profile",
              "local",
            ]);
            const json = yield* runNama(binary, environment, [
              "provider",
              "type",
              "list",
              "--profile",
              "local",
              "--output",
              "json",
            ]);

            expect(human.stderr).toContain("Plain HTTP is not encrypted.");
            expect(human.stdout).toContain("jellyfin");
            expect(json.stderr).toBe("");
            expect(json.stdout).not.toContain(token);
            const payload: unknown = JSON.parse(json.stdout);
            if (typeof payload !== "object" || payload === null || !("data" in payload)) {
              return yield* Effect.die(new Error("expected a CLI data envelope"));
            }
            expect(payload.data).toEqual({
              provider_types: [
                {
                  capabilities: [],
                  configuration_schema: {
                    additionalProperties: false,
                    properties: {
                      api_key: {
                        format: "password",
                        maxLength: 4096,
                        minLength: 1,
                        title: "API key",
                        type: "string",
                        writeOnly: true,
                        "x-nama-order": 3,
                      },
                      base_url: {
                        format: "uri",
                        maxLength: 2048,
                        minLength: 1,
                        title: "Base URL",
                        type: "string",
                        "x-nama-order": 1,
                      },
                      user_id: {
                        maxLength: 128,
                        minLength: 1,
                        title: "User ID",
                        type: "string",
                        "x-nama-order": 2,
                      },
                    },
                    required: ["base_url", "user_id", "api_key"],
                    type: "object",
                  },
                  description: "Connect Nama to a Jellyfin server.",
                  display_name: "Jellyfin",
                  id: "jellyfin",
                  schema_profile_version: 1,
                  schema_revision: "1",
                },
              ],
            });
            const configurationPath = join(home, "provider-instance.json");
            const configurationDocument = JSON.stringify({
              api_key: "provider-api-key-sentinel",
              base_url: jellyfinBaseUrl,
              user_id: "provider-user-id",
            });
            yield* Effect.promise(() =>
              writeFile(configurationPath, configurationDocument, { mode: 0o600 }),
            );
            const created = yield* runNamaWithInput({
              binary,
              environment,
              arguments_: [
                "provider",
                "instance",
                "create",
                "jellyfin",
                "--display-name",
                "Living Room",
                "--configuration",
                "-",
                "--operation-id",
                "provider-create-operation",
                "--profile",
                "local",
                "--output",
                "json",
              ],
              input: configurationDocument,
            });
            expect(created.stderr).toBe("");
            expect(created.stdout).not.toContain("provider-api-key-sentinel");
            const createdPayload: unknown = JSON.parse(created.stdout);
            if (
              typeof createdPayload !== "object" ||
              createdPayload === null ||
              !("data" in createdPayload) ||
              typeof createdPayload.data !== "object" ||
              createdPayload.data === null ||
              !("provider_instance" in createdPayload.data)
            ) {
              return yield* Effect.die(new Error("expected a created provider instance"));
            }
            const createdData = createdPayload.data as Readonly<Record<string, unknown>>;
            const createdInstance = createdData["provider_instance"] as Readonly<
              Record<string, unknown>
            >;
            expect(createdData["operation_id"]).toBe("provider-create-operation");
            expect(createdInstance).toMatchObject({
              configured_secrets: [{ configured: true, key: "api_key" }],
              configuration: {
                base_url: jellyfinBaseUrl,
                user_id: "provider-user-id",
              },
              display_name: "Living Room",
              enabled: true,
              provider_type_id: "jellyfin",
              revision: expect.any(String),
              status: "healthy",
              sync_priority: 1,
            });
            const providerInstanceId = createdInstance["id"];
            if (typeof providerInstanceId !== "string" || providerInstanceId.length === 0) {
              return yield* Effect.die(new Error("expected an opaque provider instance ID"));
            }

            const createdRevision = requiredString(createdInstance["revision"]);
            const requestsAfterCreate = requestCount();
            const metadataUpdated = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              createdRevision,
              "--display-name",
              "Family Room",
              "--sync-priority",
              "2",
              "--operation-id",
              "provider-metadata-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const metadataInstance = providerInstanceFromNamaResult(metadataUpdated);
            expect(metadataInstance).toMatchObject({
              display_name: "Family Room",
              revision: expect.any(String),
              sync_priority: 2,
            });
            expect(requestCount()).toBe(requestsAfterCreate);

            const metadataRevision = requiredString(metadataInstance["revision"]);
            const disabled = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              metadataRevision,
              "--enabled=false",
              "--operation-id",
              "provider-disable-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const disabledInstance = providerInstanceFromNamaResult(disabled);
            expect(disabledInstance).toMatchObject({
              enabled: false,
              revision: expect.any(String),
              status: "disabled",
            });
            expect(requestCount()).toBe(requestsAfterCreate);

            const reenabled = yield* runNamaWithInput({
              binary,
              environment,
              arguments_: [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                requiredString(disabledInstance["revision"]),
                "--enabled=true",
                "--configuration",
                "-",
                "--operation-id",
                "provider-reenable-update",
                "--profile",
                "local",
                "--output",
                "json",
              ],
              input: JSON.stringify({ base_url: jellyfinBaseUrl }),
            });
            const reenabledInstance = providerInstanceFromNamaResult(reenabled);
            expect(reenabledInstance).toMatchObject({
              configured_secrets: [{ configured: true, key: "api_key" }],
              enabled: true,
              revision: expect.any(String),
              status: "unavailable",
            });
            expect(reenabled.stdout).not.toContain("provider-api-key-sentinel");

            const replacementPatch = JSON.stringify({
              api_key: "replacement-provider-api-key-sentinel",
            });
            const replacementArguments = [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              requiredString(reenabledInstance["revision"]),
              "--configuration",
              "-",
              "--operation-id",
              "provider-credential-update",
              "--profile",
              "local",
              "--output",
              "json",
            ] as const;
            const replaced = yield* runNamaWithInput({
              binary,
              environment,
              arguments_: replacementArguments,
              input: replacementPatch,
            });
            const replacedInstance = providerInstanceFromNamaResult(replaced);
            expect(replacedInstance).toMatchObject({
              configured_secrets: [{ configured: true, key: "api_key" }],
              revision: expect.any(String),
            });
            expect(replaced.stdout).not.toContain("replacement-provider-api-key-sentinel");
            const replacementRetry = yield* runNamaWithInput({
              binary,
              environment,
              arguments_: replacementArguments,
              input: replacementPatch,
            });
            expect(replacementRetry.stdout).toBe(replaced.stdout);
            yield* Effect.promise(() =>
              writeFile(configurationPath, JSON.stringify({ api_key: "different-credential" }), {
                mode: 0o600,
              }),
            );
            const reusedOperation = yield* runNamaFailure(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              requiredString(reenabledInstance["revision"]),
              "--configuration",
              configurationPath,
              "--operation-id",
              "provider-credential-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expectNamaFailure(reusedOperation, 6, "idempotency_key_reused");
            const requiredClear = yield* runNamaFailure(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              requiredString(replacedInstance["revision"]),
              "--clear",
              "user_id",
              "--operation-id",
              "provider-clear-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expectNamaFailure(requiredClear, 2, "validation_failed");

            const staleUpdate = yield* runNamaFailure(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              metadataRevision,
              "--display-name",
              "Stale",
              "--operation-id",
              "provider-stale-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expectNamaFailure(staleUpdate, 6, "revision_mismatch");

            yield* Effect.promise(() =>
              writeFile(configurationPath, JSON.stringify({ user_id: "other-user" }), {
                mode: 0o600,
              }),
            );
            const changedPrincipal = yield* runNamaFailure(binary, environment, [
              "provider",
              "instance",
              "update",
              providerInstanceId,
              "--expected-revision",
              requiredString(replacedInstance["revision"]),
              "--configuration",
              configurationPath,
              "--operation-id",
              "provider-principal-update",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expectNamaFailure(changedPrincipal, 6, "provider_user_changed");
            const afterRejectedUpdate = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "get",
              providerInstanceId,
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const durableAfterRejection = providerInstanceFromNamaResult(afterRejectedUpdate);
            expect(durableAfterRejection).toMatchObject({
              configured_secrets: [{ configured: true, key: "api_key" }],
              configuration: {
                base_url: jellyfinBaseUrl,
                user_id: "provider-user-id",
              },
              revision: replacedInstance["revision"],
            });

            const concurrentUpdates = yield* Effect.promise(() =>
              Promise.allSettled([
                providerClient.updateProviderInstance(
                  {
                    configurationPatch: {},
                    displayName: "Concurrent A",
                    expectedRevision: requiredString(replacedInstance["revision"]),
                    operationId: "provider-concurrent-update-a",
                    providerInstanceId,
                  },
                  callOptions(`Bearer ${token}`),
                ),
                providerClient.updateProviderInstance(
                  {
                    configurationPatch: {},
                    displayName: "Concurrent B",
                    expectedRevision: requiredString(replacedInstance["revision"]),
                    operationId: "provider-concurrent-update-b",
                    providerInstanceId,
                  },
                  callOptions(`Bearer ${token}`),
                ),
              ]),
            );
            const concurrentSuccesses = concurrentUpdates.filter(
              (result) => result.status === "fulfilled",
            );
            const concurrentFailures = concurrentUpdates.filter(
              (result) => result.status === "rejected",
            );
            expect(concurrentSuccesses).toHaveLength(1);
            expect(concurrentFailures).toHaveLength(1);
            const concurrentSuccess = concurrentSuccesses[0];
            if (concurrentSuccess === undefined || concurrentSuccess.status !== "fulfilled") {
              return yield* Effect.die(new Error("expected one successful concurrent update"));
            }
            const winningInstance = concurrentSuccess.value.providerInstance;
            if (winningInstance === undefined) {
              return yield* Effect.die(new Error("expected the winning provider instance"));
            }
            const winningDisplayName = winningInstance.displayName;
            const winningRevision = winningInstance.revision;
            const concurrentFailure = concurrentFailures[0];
            if (
              concurrentFailure === undefined ||
              concurrentFailure.status !== "rejected" ||
              !(concurrentFailure.reason instanceof ConnectError)
            ) {
              return yield* Effect.die(new Error("expected one revision conflict"));
            }
            expect(concurrentFailure.reason.code).toBe(Code.Aborted);
            expect(concurrentFailure.reason.findDetails(ErrorInfoSchema)[0]?.reason).toBe(
              "REVISION_MISMATCH",
            );

            yield* Effect.promise(() =>
              writeFile(
                configurationPath,
                JSON.stringify({
                  user_id: "provider-user-id",
                  api_key: "provider-api-key-sentinel",
                  base_url: jellyfinBaseUrl,
                }),
                { mode: 0o600 },
              ),
            );
            const retried = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "create",
              "jellyfin",
              "--display-name",
              "Living Room",
              "--configuration",
              configurationPath,
              "--operation-id",
              "provider-create-operation",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expect(JSON.parse(retried.stdout)).toEqual(createdPayload);
            const failedCreate = (path: string, operationId: string, displayName = "Rejected") =>
              runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "create",
                "jellyfin",
                "--display-name",
                displayName,
                "--configuration",
                path,
                "--operation-id",
                operationId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
            const invalidConfigurationPath = join(home, "provider-invalid.json");
            yield* Effect.promise(() =>
              writeFile(
                invalidConfigurationPath,
                JSON.stringify({
                  base_url: jellyfinBaseUrl,
                  user_id: "provider-user-id",
                }),
              ),
            );
            expectNamaFailure(
              yield* failedCreate(invalidConfigurationPath, "invalid-operation"),
              2,
              "validation_failed",
            );
            const rejectedCredentialPath = join(home, "provider-rejected.json");
            yield* Effect.promise(() =>
              writeFile(
                rejectedCredentialPath,
                JSON.stringify({
                  api_key: "rejected-api-key",
                  base_url: jellyfinBaseUrl,
                  user_id: "provider-user-id",
                }),
              ),
            );
            expectNamaFailure(
              yield* failedCreate(rejectedCredentialPath, "rejected-operation"),
              6,
              "provider_authentication_failed",
            );
            const mismatchedPrincipalPath = join(home, "provider-mismatch.json");
            yield* Effect.promise(() =>
              writeFile(
                mismatchedPrincipalPath,
                JSON.stringify({
                  api_key: "provider-api-key-sentinel",
                  base_url: jellyfinBaseUrl,
                  user_id: "mismatch-user",
                }),
              ),
            );
            expectNamaFailure(
              yield* failedCreate(mismatchedPrincipalPath, "mismatch-operation"),
              6,
              "provider_incompatible",
            );
            const refusedConnectionPath = join(home, "provider-refused.json");
            yield* Effect.promise(() =>
              writeFile(
                refusedConnectionPath,
                JSON.stringify({
                  api_key: "provider-api-key-sentinel",
                  base_url: "http://127.0.0.1:1",
                  user_id: "provider-user-id",
                }),
              ),
            );
            expectNamaFailure(
              yield* failedCreate(refusedConnectionPath, "refused-operation"),
              7,
              "provider_unavailable",
            );
            expectNamaFailure(
              yield* failedCreate(configurationPath, "provider-create-operation", "Different"),
              6,
              "idempotency_key_reused",
            );

            const instances = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "list",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expect(instances.stderr).toBe("");
            const instanceListPayload: unknown = JSON.parse(instances.stdout);
            if (
              typeof instanceListPayload !== "object" ||
              instanceListPayload === null ||
              !("data" in instanceListPayload) ||
              typeof instanceListPayload.data !== "object" ||
              instanceListPayload.data === null ||
              !("provider_instances" in instanceListPayload.data) ||
              !Array.isArray(instanceListPayload.data.provider_instances)
            ) {
              return yield* Effect.die(new Error("expected a provider-instance list"));
            }
            expect(instanceListPayload.data.provider_instances).toHaveLength(1);
            expect(instanceListPayload.data.provider_instances[0]).toMatchObject({
              display_name: winningDisplayName,
              id: providerInstanceId,
              revision: winningRevision,
              sync_priority: 2,
            });
            expect(instanceListPayload).toMatchObject({
              warnings: [
                {
                  code: "insecure_transport",
                  message: "Plain HTTP is not encrypted.",
                },
              ],
            });

            const inspected = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "get",
              providerInstanceId,
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expect(inspected.stderr).toBe("");
            const inspectedInstance = providerInstanceFromNamaResult(inspected);
            expect(inspectedInstance).toMatchObject({
              display_name: winningDisplayName,
              id: providerInstanceId,
              revision: winningRevision,
              sync_priority: 2,
            });
            const race = yield* Effect.promise(() =>
              Promise.allSettled([
                providerClient.createProviderInstance(
                  {
                    configuration: {
                      api_key: "provider-api-key-sentinel",
                      base_url: jellyfinBaseUrl,
                      user_id: "provider-user-id",
                    },
                    displayName: "Race A",
                    enabled: true,
                    operationId: "race-operation-a",
                    providerTypeId: "jellyfin",
                    syncPriority: 3,
                  },
                  callOptions(`Bearer ${token}`),
                ),
                providerClient.createProviderInstance(
                  {
                    configuration: {
                      api_key: "provider-api-key-sentinel",
                      base_url: jellyfinBaseUrl,
                      user_id: "provider-user-id",
                    },
                    displayName: "Race B",
                    enabled: true,
                    operationId: "race-operation-b",
                    providerTypeId: "jellyfin",
                    syncPriority: 3,
                  },
                  callOptions(`Bearer ${token}`),
                ),
              ]),
            );
            const committed = race.find((result) => result.status === "fulfilled");
            const conflicted = race.find((result) => result.status === "rejected");
            expect(race.filter((result) => result.status === "fulfilled")).toHaveLength(1);
            expect(race.filter((result) => result.status === "rejected")).toHaveLength(1);
            expect(
              committed?.status === "fulfilled"
                ? committed.value.providerInstance?.syncPriority
                : undefined,
            ).toBe(3);
            if (conflicted?.status !== "rejected") {
              return yield* Effect.die(new Error("expected one concurrent priority conflict"));
            }
            const conflict = ConnectError.from(conflicted.reason);
            expect(conflict.code).toBe(Code.InvalidArgument);
            expect(conflict.findDetails(ErrorInfoSchema)[0]?.reason).toBe("VALIDATION_FAILED");
            expect(conflict.findDetails(BadRequestSchema)[0]?.fieldViolations).toMatchObject([
              { field: "sync_priority", reason: "CONFLICT" },
            ]);
            const firstInstancePage = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "list",
              "--page-size",
              "1",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const firstInstancePagePayload = JSON.parse(firstInstancePage.stdout) as {
              readonly data: {
                readonly next_page_token: string;
                readonly provider_instances: readonly Readonly<Record<string, unknown>>[];
              };
            };
            expect(firstInstancePagePayload.data.provider_instances).toHaveLength(1);
            expect(firstInstancePagePayload.data.next_page_token).toEqual(expect.any(String));
            expect(firstInstancePagePayload.data.next_page_token.length).toBeGreaterThan(0);
            const replacement = firstInstancePagePayload.data.next_page_token.endsWith("A")
              ? "B"
              : "A";
            const tamperedPageToken =
              firstInstancePagePayload.data.next_page_token.slice(0, -1) + replacement;
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "list",
                "--page-size",
                "1",
                "--page-token",
                tamperedPageToken,
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              2,
              "page_token_invalid",
            );
            const secondInstancePage = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "list",
              "--page-size",
              "1",
              "--page-token",
              firstInstancePagePayload.data.next_page_token,
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const secondInstancePagePayload = JSON.parse(secondInstancePage.stdout) as {
              readonly data: {
                readonly next_page_token?: string;
                readonly provider_instances: readonly Readonly<Record<string, unknown>>[];
              };
            };
            expect(secondInstancePagePayload.data.provider_instances).toHaveLength(1);
            expect(secondInstancePagePayload.data.next_page_token).toBeUndefined();
            const pagedInstanceIds = [
              requiredString(firstInstancePagePayload.data.provider_instances[0]?.["id"]),
              requiredString(secondInstancePagePayload.data.provider_instances[0]?.["id"]),
            ].toSorted((left, right) => left.localeCompare(right));
            const racedInstanceId =
              committed?.status === "fulfilled" ? committed.value.providerInstance?.id : undefined;
            expect(pagedInstanceIds).toEqual(
              [providerInstanceId, requiredString(racedInstanceId)].toSorted((left, right) =>
                left.localeCompare(right),
              ),
            );
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "get",
                "missing-provider-instance",
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              5,
              "resource_not_found",
            );
            const duplicateRequest = {
              configuration: {
                api_key: "provider-api-key-sentinel",
                base_url: jellyfinBaseUrl,
                user_id: "provider-user-id",
              },
              displayName: "Concurrent Duplicate",
              enabled: true,
              operationId: "concurrent-duplicate-operation",
              providerTypeId: "jellyfin",
            } as const;
            const duplicateResults = yield* Effect.promise(() =>
              Promise.all([
                providerClient.createProviderInstance(
                  duplicateRequest,
                  callOptions(`Bearer ${token}`),
                ),
                providerClient.createProviderInstance(
                  duplicateRequest,
                  callOptions(`Bearer ${token}`),
                ),
              ]),
            );
            expect(duplicateResults[0]?.providerInstance?.id).toBe(
              duplicateResults[1]?.providerInstance?.id,
            );
            expect(duplicateResults[0]?.providerInstance?.revision).toBe(
              duplicateResults[1]?.providerInstance?.revision,
            );
            const defaultPriorityResults = yield* Effect.promise(() =>
              Promise.all([
                providerClient.createProviderInstance(
                  {
                    ...duplicateRequest,
                    displayName: "Default A",
                    operationId: "default-priority-a",
                  },
                  callOptions(`Bearer ${token}`),
                ),
                providerClient.createProviderInstance(
                  {
                    ...duplicateRequest,
                    displayName: "Default B",
                    operationId: "default-priority-b",
                  },
                  callOptions(`Bearer ${token}`),
                ),
              ]),
            );
            expect(
              defaultPriorityResults
                .map((result) => result.providerInstance?.syncPriority)
                .toSorted((left, right) => (left ?? 0) - (right ?? 0)),
            ).toEqual([5, 6]);
            const generatedOperation = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "create",
              "jellyfin",
              "--display-name",
              "Generated Operation",
              "--configuration",
              configurationPath,
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const generatedOperationPayload = JSON.parse(generatedOperation.stdout) as {
              readonly data: { readonly operation_id: string };
            };
            expect(generatedOperationPayload.data.operation_id).toMatch(/^[A-Za-z0-9_-]{32}$/u);
            const generatedInstance = providerInstanceFromNamaResult(generatedOperation);
            const generatedInstanceId = requiredString(generatedInstance["id"]);
            const generatedRevision = requiredString(generatedInstance["revision"]);
            const [concurrentDisable, concurrentDelete] = yield* Effect.all(
              [
                runNama(binary, environment, [
                  "provider",
                  "instance",
                  "update",
                  generatedInstanceId,
                  "--expected-revision",
                  generatedRevision,
                  "--enabled=false",
                  "--operation-id",
                  "concurrent-delete-disable",
                  "--profile",
                  "local",
                  "--output",
                  "json",
                ]),
                runNamaFailure(binary, environment, [
                  "provider",
                  "instance",
                  "delete",
                  generatedInstanceId,
                  "--expected-revision",
                  generatedRevision,
                  "--operation-id",
                  "concurrent-delete-attempt",
                  "--yes",
                  "--profile",
                  "local",
                  "--output",
                  "json",
                ]),
              ] as const,
              { concurrency: "unbounded" },
            );
            expect(providerInstanceFromNamaResult(concurrentDisable)).toMatchObject({
              enabled: false,
            });
            expect(concurrentDelete.exitCode).toBe(6);
            const concurrentDeletePayload = JSON.parse(concurrentDelete.stderr) as {
              readonly error: { readonly code: string };
            };
            expect(["provider_instance_busy", "revision_mismatch"]).toContain(
              concurrentDeletePayload.error.code,
            );
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "delete",
                providerInstanceId,
                "--expected-revision",
                winningRevision,
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              2,
              "invalid_argument",
            );
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "delete",
                providerInstanceId,
                "--expected-revision",
                winningRevision,
                "--operation-id",
                "provider-enabled-delete",
                "--yes",
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              6,
              "provider_instance_busy",
            );
            const disabledForDeletion = yield* Effect.promise(() =>
              providerClient.updateProviderInstance(
                {
                  configurationPatch: {},
                  enabled: false,
                  expectedRevision: winningRevision,
                  operationId: "provider-delete-disable",
                  providerInstanceId,
                },
                callOptions(`Bearer ${token}`),
              ),
            );
            const deletionRevision = requiredString(disabledForDeletion.providerInstance?.revision);
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "delete",
                providerInstanceId,
                "--expected-revision",
                winningRevision,
                "--operation-id",
                "provider-stale-delete",
                "--yes",
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              6,
              "revision_mismatch",
            );
            const requestsBeforeDelete = requestCount();
            const deleteArguments = [
              "provider",
              "instance",
              "delete",
              providerInstanceId,
              "--expected-revision",
              deletionRevision,
              "--operation-id",
              "provider-delete-operation",
              "--yes",
              "--profile",
              "local",
              "--output",
              "json",
            ] as const;
            const deleted = yield* runNama(binary, environment, deleteArguments);
            expect(deleted.stderr).toBe("");
            expect(JSON.parse(deleted.stdout)).toMatchObject({
              data: { operation_id: "provider-delete-operation" },
            });
            expect(deleted.stdout).not.toContain("provider-api-key-sentinel");
            const deleteRetry = yield* runNama(binary, environment, deleteArguments);
            expect(deleteRetry.stdout).toBe(deleted.stdout);
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                ...deleteArguments.slice(0, 5),
                "different-revision",
                ...deleteArguments.slice(6),
              ]),
              6,
              "idempotency_key_reused",
            );
            expectNamaFailure(
              yield* runNamaFailure(binary, environment, [
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]),
              5,
              "resource_not_found",
            );
            const afterDeleteList = yield* runNama(binary, environment, [
              "provider",
              "instance",
              "list",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            const afterDeletePayload = JSON.parse(afterDeleteList.stdout) as {
              readonly data: {
                readonly provider_instances: readonly Readonly<Record<string, unknown>>[];
              };
            };
            expect(
              afterDeletePayload.data.provider_instances.some(
                (instance) => instance["id"] === providerInstanceId,
              ),
            ).toBe(false);
            const providerTypesAfterDelete = yield* runNama(binary, environment, [
              "provider",
              "type",
              "list",
              "--profile",
              "local",
              "--output",
              "json",
            ]);
            expect(providerTypesAfterDelete.stdout).toContain('"id":"jellyfin"');
            const deletionFacts = yield* Effect.promise(async () => {
              const observer = new Pool({ connectionString: databaseUrl });
              try {
                const result = await observer.query<{
                  readonly credential_exists: boolean;
                  readonly instance_exists: boolean;
                  readonly observation_exists: boolean;
                  readonly operation_exists: boolean;
                }>(
                  `SELECT
                    EXISTS (SELECT 1 FROM provider_instance WHERE id = $1)
                      AS instance_exists,
                    EXISTS (SELECT 1 FROM provider_credential WHERE provider_instance_id = $1)
                      AS credential_exists,
                    EXISTS (
                      SELECT 1 FROM provider_instance_observation
                      WHERE provider_instance_id = $1
                    ) AS observation_exists,
                    EXISTS (
                      SELECT 1 FROM provider_operation_result
                      WHERE method = 'nama.api.v1.ProviderService.DeleteProviderInstance'
                        AND operation_id = 'provider-delete-operation'
                    ) AS operation_exists`,
                  [providerInstanceId],
                );
                return result.rows[0];
              } finally {
                await observer.end();
              }
            });
            expect(deletionFacts).toEqual({
              credential_exists: false,
              instance_exists: false,
              observation_exists: false,
              operation_exists: true,
            });
            expect(requestCount()).toBe(requestsBeforeDelete);
            expect(runningProcess.stdout()).not.toContain(token);
            expect(runningProcess.stderr()).not.toContain(token);
            yield* stopCleanly(runningProcess);
          }),
        ),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "keeps provider state intact when real supervised cleanup blocks compiled deletion",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "nama-provider-delete-cleanup-"))),
      (controlDirectory) =>
        withNamaBinary(({ binary, home }) =>
          Effect.scoped(
            Effect.gen(function* providerDeleteCleanupFailureTest() {
              const supervisor = yield* PluginSupervisor;
              const providerInstanceId = "provider-instance-cleanup-failure";
              const revision = "revision-cleanup-failure";
              const handleScope = yield* Scope.make();
              const plugin = yield* Scope.provide(handleScope)(
                supervisor.supervise(
                  {
                    arguments: [PLUGIN_FIXTURE_PATH, controlDirectory, "cleanup-failure"],
                    executable: process.execPath,
                    expectedProviderType: "fixture",
                    stderrEvents: [],
                  },
                  {
                    configuration: {},
                    credentials: {},
                    kind: "instance",
                    providerInstanceId,
                    revision,
                  },
                ),
              );
              yield* plugin.call(HealthService.method.check, {}, PLUGIN_CALL_DEADLINE_MILLISECONDS);
              const launchContent = yield* Effect.promise(() =>
                readFile(join(controlDirectory, "launches.ndjson"), "utf8"),
              );
              const firstLaunch = launchContent.trim().split("\n")[0];
              if (firstLaunch === undefined) {
                return yield* Effect.die(new Error("cleanup fixture launch record missing"));
              }
              const launchRecord = JSON.parse(firstLaunch) as Readonly<Record<string, unknown>>;
              const runtimeRoot = dirname(dirname(requiredString(launchRecord["socketPath"])));

              const createdAt = new Date("2026-08-20T08:00:00.000Z");
              let current: ProviderInstanceRecord | undefined = {
                configuration: {
                  base_url: "http://127.0.0.1:8096",
                  user_id: "provider-user",
                },
                configuredSecretKeys: ["api_key"],
                createdAt,
                credentialsAvailable: true,
                displayName: "Cleanup failure",
                enabled: false,
                id: providerInstanceId,
                observation: { status: "healthy", summary: "Connected" },
                providerTypeId: "jellyfin",
                revision,
                syncPriority: 1,
                updatedAt: createdAt,
              };
              let deleteCalls = 0;
              const persistence = {
                ...unusedProviderPersistence,
                deleteInstance: () =>
                  Effect.sync(() => {
                    deleteCalls += 1;
                    current = undefined;
                    return true;
                  }),
                loadInstanceRecord: () => Effect.succeed(current),
                readOperationResult: () => NO_OPERATION_RESULT,
              } satisfies ProviderPersistence;
              const providerManagement = yield* makeProviderDeleteTestManagement(
                persistence,
                (fencedProviderInstanceId, mode) =>
                  supervisor.fenceInstance(fencedProviderInstanceId, mode),
                MASTER_KEY,
              );
              const listener = createTestConnectRequestListener(providerManagement);
              const verifyCleanupFailure = Effect.gen(function* compiledDeleteCleanupFailureTest() {
                const retained = yield* Effect.promise(() =>
                  withEphemeralServer(listener, (origin) =>
                    Effect.runPromise(
                      Effect.gen(function* compiledDeleteRequestTest() {
                        const environment = cliEnvironment(home, "test.signed-bearer");
                        yield* runNama(binary, environment, [
                          "profile",
                          "set",
                          "local",
                          "--server",
                          origin,
                          "--output",
                          "json",
                        ]);
                        expectNamaFailure(
                          yield* runNamaFailure(binary, environment, [
                            "provider",
                            "instance",
                            "delete",
                            providerInstanceId,
                            "--expected-revision",
                            revision,
                            "--operation-id",
                            "cleanup-failure-delete",
                            "--yes",
                            "--profile",
                            "local",
                            "--output",
                            "json",
                          ]),
                          7,
                          "plugin_unavailable",
                        );
                        return yield* runNama(binary, environment, [
                          "provider",
                          "instance",
                          "get",
                          providerInstanceId,
                          "--profile",
                          "local",
                          "--output",
                          "json",
                        ]);
                      }),
                    ),
                  ),
                );

                const retainedInstance = providerInstanceFromNamaResult(retained);
                expect(retainedInstance).toMatchObject({
                  enabled: false,
                  id: providerInstanceId,
                  revision,
                });
                expect(deleteCalls).toBe(0);
              });
              const restoreRuntimeRoot = Effect.promise(() => chmod(runtimeRoot, 0o700));
              const closeHandleScope = Scope.close(handleScope, Exit.void);
              const cleanupFixture = restoreRuntimeRoot.pipe(
                Effect.andThen(closeHandleScope),
                Effect.orDie,
              );
              yield* verifyCleanupFailure.pipe(Effect.ensuring(cleanupFixture));
            }).pipe(Effect.provide(PLUGIN_SUPERVISOR_LAYER)),
          ),
        ),
      (controlDirectory) =>
        Effect.promise(() => rm(controlDirectory, { force: true, recursive: true })),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
