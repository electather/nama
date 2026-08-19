// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary, eslint/prefer-destructuring, eslint/sort-keys, promise/avoid-new, promise/prefer-await-to-callbacks, typescript/consistent-return, typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion, typescript/strict-boolean-expressions, typescript/strict-void-return -- This executable flow keeps the CLI, server, PostgreSQL, subprocess, controlled HTTP provider, and exact process streams visible in one scenario.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { Effect } from "effect";

import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { startProcess } from "./process.test-support.ts";

const execFilePromise = promisify(execFile);
const REPOSITORY_ROOT = join(import.meta.dirname, "../../../..");
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
  use: (baseUrl: string) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(
      () =>
        new Promise<Readonly<{ readonly baseUrl: string; readonly server: Server }>>(
          (resolve, reject) => {
            const server = createServer((request, response) => {
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
                authorization === 'MediaBrowser Token="provider-api-key-sentinel"'
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
                server,
              });
            });
          },
        ),
    ),
    ({ baseUrl }) => use(baseUrl),
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
    withControlledJellyfin((jellyfinBaseUrl) =>
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
            expect(instanceListPayload).toEqual({
              data: { provider_instances: [createdInstance] },
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
            expect(JSON.parse(inspected.stdout)).toEqual({
              data: { provider_instance: createdInstance },
              warnings: [
                {
                  code: "insecure_transport",
                  message: "Plain HTTP is not encrypted.",
                },
              ],
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
                    syncPriority: 2,
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
                    syncPriority: 2,
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
            ).toBe(2);
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
            ).toEqual([4, 5]);
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
            expect(runningProcess.stdout()).not.toContain(token);
            expect(runningProcess.stderr()).not.toContain(token);
            yield* stopCleanly(runningProcess);
          }),
        ),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
