// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers -- This integration tracer keeps each restart, durable mutation, security sentinel, and real external process visible in execution order.
import { createHash } from "node:crypto";
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectConnectFailure,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import {
  cliEnvironment,
  createNamaRunner,
  dataFromNama,
  providerInstanceFromNama,
  withNamaBinary,
} from "./compiled-cli.test-support.ts";
import type { NamaResult } from "./compiled-cli.test-support.ts";
import { withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { MASTER_KEY, startProcess, structuredLinesFrom } from "./process.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";
import {
  provisionJellyfin,
  requiredString,
  revokeJellyfinCredential,
} from "./provider-durable-loop.test-support.ts";
import type { JellyfinFixture } from "./provider-durable-loop.test-support.ts";

const TEST_TIMEOUT_MILLISECONDS = 180_000;
const WRONG_MASTER_KEY = `base64:${Buffer.alloc(32, 23).toString("base64")}`;
const ADMINISTRATOR = Object.freeze({
  displayName: "Durable Provider Administrator",
  email: "durable-provider@example.test",
  password: "durable-provider-password-sentinel",
});
const CREATE_OPERATION_ID = "durable-provider-operation";
const PROVIDER_TYPE_ID = "jellyfin";
const BUNDLED_PLUGIN_OVERRIDE_PATH = join(
  import.meta.dirname,
  "fixtures/bundled-plugin-override.mjs",
);

type BundledPluginState =
  | "absent"
  | "discovery-failure"
  | "malformed-discovery"
  | "newer-incompatible";
type ReconciliationStatus = "available" | "incompatible" | "unavailable";

const bundledPluginOverrideOptions = (home: string, state: BundledPluginState) => ({
  environment: {
    NAMA_TEST_BUNDLED_PLUGIN_CONTROL_DIRECTORY: join(home, `bundled-plugin-${state}`),
    NAMA_TEST_BUNDLED_PLUGIN_MODE: state,
  },
  preloads: [BUNDLED_PLUGIN_OVERRIDE_PATH],
});

interface SecrecySentinel {
  readonly name: string;
  readonly value: string;
}

interface SecrecyBoundary {
  readonly contents: readonly string[];
  readonly sentinels: readonly SecrecySentinel[];
}

interface InstallationSnapshot {
  readonly configurationSchema: Readonly<Record<string, unknown>>;
  readonly pluginBuildVersion: string;
  readonly schemaRevision: string;
}
interface RetainedReconciliationStateExpectation {
  readonly databaseUrl: string;
  readonly expectedConfiguration: Readonly<Record<string, unknown>>;
  readonly expectedInstallation: InstallationSnapshot;
  readonly expectedStatus: ReconciliationStatus;
  readonly providerInstanceId: string;
  readonly runningProcess: RunningProcess;
}

interface RestartProcessInput {
  readonly currentProcess: RunningProcess;
  readonly databaseUrl: string;
  readonly launchOptions?: Parameters<typeof startProcess>[2];
  readonly port: number;
  readonly processes: RunningProcess[];
}

const propertyFrom = (value: unknown, property: string): unknown => {
  if (typeof value !== "object" || value === null || !(property in value)) {
    return undefined;
  }
  return Reflect.get(value, property);
};

const expectNamaSuccess = (result: NamaResult): void => {
  expect(result.exitCode).toBe(0);
  expect(result.stderr.length === 0).toBe(true);
};

// oxlint-disable-next-line eslint/max-params -- One assertion binds the process result, exit class, stable code, and values that must remain redacted.
const expectNamaFailure = (
  result: NamaResult,
  exitCode: number,
  code: string,
  sentinels: readonly SecrecySentinel[],
): void => {
  expect(result.exitCode).toBe(exitCode);
  expect(result.stdout.length === 0).toBe(true);
  const payload: unknown = JSON.parse(result.stderr);
  const error = propertyFrom(payload, "error");
  const observedCode = propertyFrom(error, "code");
  expect(observedCode).toBe(code);
  expectSentinelsAbsent([{ contents: [result.stderr], sentinels }]);
};

const expectSentinelsAbsent = (boundaries: readonly SecrecyBoundary[]): void => {
  for (const boundary of boundaries) {
    for (const sentinel of boundary.sentinels) {
      if (sentinel.value.length > 0) {
        const exposed = boundary.contents.some((content) => content.includes(sentinel.value));
        expect(exposed).toBe(false);
      }
    }
  }
};
const structuredRecord = (line: string): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected a structured log record");
  }
  return Object.fromEntries(Object.entries(value));
};

const readInstallation = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async (): Promise<InstallationSnapshot> => {
      const result = await pool.query<{
        readonly configuration_schema: unknown;
        readonly plugin_build_version: string;
        readonly schema_revision: string;
      }>(
        "SELECT configuration_schema, plugin_build_version, schema_revision FROM provider_installation WHERE provider_type_id = $1",
        [PROVIDER_TYPE_ID],
      );
      const [row] = result.rows;
      if (
        row === undefined ||
        typeof row.configuration_schema !== "object" ||
        row.configuration_schema === null ||
        Array.isArray(row.configuration_schema)
      ) {
        throw new TypeError("expected the accepted Jellyfin installation");
      }
      return {
        configurationSchema: Object.fromEntries(Object.entries(row.configuration_schema)),
        pluginBuildVersion: row.plugin_build_version,
        schemaRevision: row.schema_revision,
      };
    }),
  );

const writeInstallation = (databaseUrl: string, installation: InstallationSnapshot) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query(
        "UPDATE provider_installation SET configuration_schema = $1::jsonb, plugin_build_version = $2, schema_revision = $3, updated_at = CURRENT_TIMESTAMP WHERE provider_type_id = $4",
        [
          JSON.stringify(installation.configurationSchema),
          installation.pluginBuildVersion,
          installation.schemaRevision,
          PROVIDER_TYPE_ID,
        ],
      ),
    ),
  );

const readInstanceScopedProviderStateWithGlobalOperationResults = (
  databaseUrl: string,
  providerInstanceId: string,
) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async () => {
      const [
        instanceScopedInstances,
        instanceScopedCredentials,
        instanceScopedObservations,
        globalOperationResults,
      ] = await Promise.all([
        pool.query<{
          readonly configuration: unknown;
          readonly display_name: string;
          readonly enabled: boolean;
          readonly id: string;
          readonly principal_digest: string;
          readonly provider_type_id: string;
          readonly revision: string;
          readonly sync_priority: string;
        }>(
          "SELECT configuration, display_name, enabled, id, encode(principal_digest, 'hex') AS principal_digest, provider_type_id, revision, sync_priority::text FROM provider_instance WHERE id = $1",
          [providerInstanceId],
        ),
        pool.query<{
          readonly authentication_tag_bytes: number;
          readonly ciphertext: string;
          readonly configuration_key: string;
          readonly envelope_version: number;
          readonly nonce_bytes: number;
        }>(
          "SELECT configuration_key, envelope_version, octet_length(nonce)::int AS nonce_bytes, encode(ciphertext, 'hex') AS ciphertext, octet_length(authentication_tag)::int AS authentication_tag_bytes FROM provider_credential WHERE provider_instance_id = $1",
          [providerInstanceId],
        ),
        pool.query<{
          readonly instance_revision: string;
          readonly status: string;
          readonly summary: string;
        }>(
          "SELECT instance_revision, status, summary FROM provider_instance_observation WHERE provider_instance_id = $1",
          [providerInstanceId],
        ),
        pool.query<{
          readonly method: string;
          readonly operation_id: string;
          readonly request_fingerprint: string;
          readonly serialized_result: unknown;
        }>(
          "SELECT method, operation_id, encode(request_fingerprint, 'hex') AS request_fingerprint, serialized_result FROM provider_operation_result ORDER BY method, operation_id",
        ),
      ]);
      return {
        globalOperationResults: globalOperationResults.rows,
        instanceScopedCredentials: instanceScopedCredentials.rows,
        instanceScopedInstances: instanceScopedInstances.rows,
        instanceScopedObservations: instanceScopedObservations.rows,
      };
    }),
  );
const expectRetainedReconciliationState = (input: RetainedReconciliationStateExpectation) =>
  Effect.gen(function* retainedReconciliationState() {
    expect(yield* readInstallation(input.databaseUrl)).toEqual(input.expectedInstallation);
    const stateWithGlobalOperationResults =
      yield* readInstanceScopedProviderStateWithGlobalOperationResults(
        input.databaseUrl,
        input.providerInstanceId,
      );
    expect(stateWithGlobalOperationResults.instanceScopedInstances).toHaveLength(1);
    expect(stateWithGlobalOperationResults.instanceScopedInstances[0]?.configuration).toEqual(
      input.expectedConfiguration,
    );
    const records = structuredLinesFrom(input.runningProcess).map((line) => structuredRecord(line));
    expect(
      records.find((record) => record["event"] === "provider.discovery_completed"),
    ).toMatchObject({ provider_type: PROVIDER_TYPE_ID, status: input.expectedStatus });
  });

const rawPrincipalReference = (jellyfin: JellyfinFixture): string => {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([jellyfin.serverId.toLowerCase(), jellyfin.primaryUserId.toLowerCase()]),
      "utf8",
    )
    .digest("base64url");
  return `jellyfin/v1:${digest}`;
};

const restartProcess = (input: RestartProcessInput) =>
  Effect.gen(function* restartingProcess() {
    yield* stopCleanly(input.currentProcess);
    const restartedProcess = yield* startProcess(
      input.databaseUrl,
      input.port,
      input.launchOptions,
    );
    input.processes.push(restartedProcess);
    yield* expectReady(restartedProcess);
    return restartedProcess;
  });

it.live(
  "drives a durable provider loop through the compiled CLI and real Jellyfin",
  () =>
    provisionJellyfin.pipe(
      Effect.flatMap((jellyfin) =>
        withIsolatedDatabase((databaseUrl) =>
          withNamaBinary(({ binary, home }) =>
            Effect.gen(function* durableProviderLoopTest() {
              const processes: RunningProcess[] = [];
              const cliResults: NamaResult[] = [];
              const providerArguments: (readonly string[])[] = [];
              const diagnosticMetadata: string[] = [];
              const diagnosticResponses: string[] = [];
              const principalReference = rawPrincipalReference(jellyfin);
              const initialPersistedConfiguration = Object.freeze({
                base_url: jellyfin.baseUrl,
                user_id: jellyfin.primaryUserId,
              });
              const initialConfiguration = JSON.stringify({
                api_key: jellyfin.primaryApiKey,
                ...initialPersistedConfiguration,
              });
              const secrecySentinels: SecrecySentinel[] = [
                { name: "Jellyfin primary API key", value: jellyfin.primaryApiKey },
                { name: "Jellyfin replacement API key", value: jellyfin.replacementApiKey },
                { name: "Jellyfin server ID", value: jellyfin.serverId },
                { name: "Jellyfin provider principal", value: principalReference },
                { name: "server master key", value: MASTER_KEY },
                { name: "wrong server master key", value: WRONG_MASTER_KEY },
                { name: "Administrator password", value: ADMINISTRATOR.password },
              ];
              const nonPublicSentinels = (): readonly SecrecySentinel[] => [
                ...secrecySentinels,
                { name: "Jellyfin configuration payload", value: initialConfiguration },
                { name: "Jellyfin base URL", value: jellyfin.baseUrl },
                { name: "Jellyfin primary user ID", value: jellyfin.primaryUserId },
                { name: "Jellyfin alternate user ID", value: jellyfin.otherUserId },
                { name: "Jellyfin disabled user ID", value: jellyfin.disabledUserId },
                { name: "database configuration URL", value: databaseUrl },
              ];

              let runningProcess = yield* startProcess(databaseUrl);
              processes.push(runningProcess);
              yield* expectReady(runningProcess);
              let clients = clientsFor(runningProcess.origin);
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
                phase: "create durable-loop Administrator",
              });
              const signIn = yield* expectRpcSuccess({
                invoke: () =>
                  clients.authentication.signIn(
                    { email: ADMINISTRATOR.email, password: ADMINISTRATOR.password },
                    callOptions(),
                  ),
                phase: "sign in durable-loop Administrator",
              });
              const administratorToken = signIn.credential?.token;
              if (administratorToken === undefined || administratorToken.length === 0) {
                return yield* Effect.die(new Error("expected an Administrator credential"));
              }
              secrecySentinels.push({
                name: "Administrator bearer token",
                value: administratorToken,
              });
              const environment = cliEnvironment(home, administratorToken);
              const runNama = createNamaRunner(binary, environment);
              const profile = yield* runNama([
                "profile",
                "set",
                "local",
                "--server",
                runningProcess.origin,
                "--output",
                "json",
              ]);
              cliResults.push(profile);
              expectNamaSuccess(profile);

              const providerTypes = yield* runNama([
                "provider",
                "type",
                "list",
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(providerTypes);
              expectNamaSuccess(providerTypes);
              expect(dataFromNama(providerTypes)).toMatchObject({
                provider_types: [
                  {
                    capabilities: ["library_read", "artwork_resolve", "watched_write"],
                    id: PROVIDER_TYPE_ID,
                    schema_revision: "1",
                  },
                ],
              });

              const createArguments = [
                "provider",
                "instance",
                "create",
                PROVIDER_TYPE_ID,
                "--display-name",
                "Living Room",
                "--configuration",
                "-",
                "--operation-id",
                CREATE_OPERATION_ID,
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(createArguments);
              const created = yield* runNama(createArguments, initialConfiguration);
              cliResults.push(created);
              expectNamaSuccess(created);
              const createdInstance = providerInstanceFromNama(created);
              expect(dataFromNama(created)["operation_id"]).toBe(CREATE_OPERATION_ID);
              expect(createdInstance).toMatchObject({
                configuration: {
                  base_url: jellyfin.baseUrl,
                  user_id: jellyfin.primaryUserId,
                },
                configured_secrets: [{ configured: true, key: "api_key" }],
                display_name: "Living Room",
                enabled: true,
                provider_type_id: PROVIDER_TYPE_ID,
                status: "healthy",
                sync_priority: 1,
              });
              const providerInstanceId = requiredString(createdInstance, "id");
              const createdRevision = requiredString(createdInstance, "revision");
              const durableCreated =
                yield* readInstanceScopedProviderStateWithGlobalOperationResults(
                  databaseUrl,
                  providerInstanceId,
                );
              const [durableInstance] = durableCreated.instanceScopedInstances;
              expect(durableInstance).toMatchObject({
                configuration: {
                  base_url: jellyfin.baseUrl,
                  user_id: jellyfin.primaryUserId,
                },
                enabled: true,
                id: providerInstanceId,
                provider_type_id: PROVIDER_TYPE_ID,
                revision: createdRevision,
                sync_priority: "1",
              });
              expect(durableInstance?.principal_digest).toMatch(/^[0-9a-f]{64}$/u);
              expect(durableCreated.instanceScopedCredentials).toMatchObject([
                {
                  authentication_tag_bytes: 16,
                  configuration_key: "api_key",
                  envelope_version: 1,
                  nonce_bytes: 12,
                },
              ]);
              expectSentinelsAbsent([
                {
                  contents: [durableCreated.instanceScopedCredentials[0]?.ciphertext ?? ""],
                  sentinels: [
                    {
                      name: "hex-encoded Jellyfin primary API key",
                      value: Buffer.from(jellyfin.primaryApiKey, "utf8").toString("hex"),
                    },
                  ],
                },
              ]);
              expect(durableCreated.instanceScopedObservations).toMatchObject([
                {
                  instance_revision: createdRevision,
                  status: "healthy",
                  summary: "Connected",
                },
              ]);
              expectSentinelsAbsent([
                { contents: [JSON.stringify(durableCreated)], sentinels: secrecySentinels },
              ]);
              const diagnosticFailure = yield* expectConnectFailure({
                expectedCode: Code.Unimplemented,
                invoke: () =>
                  clients.health.getDiagnostics({}, callOptions(`Bearer ${administratorToken}`)),
                publicErrors: [],
              });
              diagnosticResponses.push(
                JSON.stringify({
                  code: diagnosticFailure.code,
                  rawMessage: diagnosticFailure.rawMessage,
                }),
              );
              diagnosticMetadata.push(JSON.stringify([...diagnosticFailure.metadata.entries()]));

              const port = Number(new URL(runningProcess.origin).port);
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                port,
                processes,
              });
              const restartedGet = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(restartedGet);
              expectNamaSuccess(restartedGet);
              expect(providerInstanceFromNama(restartedGet)).toEqual(createdInstance);
              const createRetry = yield* runNama(createArguments, initialConfiguration);
              cliResults.push(createRetry);
              expectNamaSuccess(createRetry);
              expect(createRetry.stdout).toBe(created.stdout);

              yield* stopCleanly(runningProcess);
              const acceptedInstallation = yield* readInstallation(databaseUrl);
              yield* writeInstallation(databaseUrl, {
                ...acceptedInstallation,
                pluginBuildVersion: "0.0.0-prior",
                schemaRevision: "0",
              });
              runningProcess = yield* startProcess(databaseUrl, port);
              processes.push(runningProcess);
              yield* expectReady(runningProcess);
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: acceptedInstallation,
                expectedStatus: "available",
                providerInstanceId,
                runningProcess,
              });
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                launchOptions: bundledPluginOverrideOptions(home, "absent"),
                port,
                processes,
              });
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: acceptedInstallation,
                expectedStatus: "unavailable",
                providerInstanceId,
                runningProcess,
              });
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                launchOptions: bundledPluginOverrideOptions(home, "discovery-failure"),
                port,
                processes,
              });
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: acceptedInstallation,
                expectedStatus: "unavailable",
                providerInstanceId,
                runningProcess,
              });
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                launchOptions: bundledPluginOverrideOptions(home, "malformed-discovery"),
                port,
                processes,
              });
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: acceptedInstallation,
                expectedStatus: "incompatible",
                providerInstanceId,
                runningProcess,
              });
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                launchOptions: bundledPluginOverrideOptions(home, "newer-incompatible"),
                port,
                processes,
              });
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: acceptedInstallation,
                expectedStatus: "incompatible",
                providerInstanceId,
                runningProcess,
              });
              yield* stopCleanly(runningProcess);

              const { properties } = acceptedInstallation.configurationSchema;
              if (
                typeof properties !== "object" ||
                properties === null ||
                Array.isArray(properties)
              ) {
                return yield* Effect.die(new Error("expected accepted schema properties"));
              }
              const futureInstallation: InstallationSnapshot = {
                configurationSchema: {
                  ...acceptedInstallation.configurationSchema,
                  properties: {
                    ...properties,
                    future_region: { title: "Future region", type: "string", "x-nama-order": 4 },
                  },
                },
                pluginBuildVersion: "99.0.0-future",
                schemaRevision: "2",
              };
              yield* writeInstallation(databaseUrl, futureInstallation);
              runningProcess = yield* startProcess(databaseUrl, port);
              processes.push(runningProcess);
              yield* expectReady(runningProcess);
              yield* expectRetainedReconciliationState({
                databaseUrl,
                expectedConfiguration: initialPersistedConfiguration,
                expectedInstallation: futureInstallation,
                expectedStatus: "incompatible",
                providerInstanceId,
                runningProcess,
              });
              const upgradeSafeRead = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(upgradeSafeRead);
              expectNamaSuccess(upgradeSafeRead);
              expect(providerInstanceFromNama(upgradeSafeRead)).toEqual(createdInstance);
              yield* stopCleanly(runningProcess);
              yield* writeInstallation(databaseUrl, acceptedInstallation);

              runningProcess = yield* startProcess(databaseUrl, port, {
                masterKey: WRONG_MASTER_KEY,
              });
              processes.push(runningProcess);
              yield* expectReady(runningProcess);
              clients = clientsFor(runningProcess.origin);
              const wrongKeyStatus = yield* expectRpcSuccess({
                invoke: () => clients.setup.getStatus({}, callOptions()),
                phase: "wrong-key GetStatus",
              });
              expect(wrongKeyStatus.initialized).toBe(true);
              const wrongKeySignIn = yield* expectRpcSuccess({
                invoke: () =>
                  clients.authentication.signIn(
                    { email: ADMINISTRATOR.email, password: ADMINISTRATOR.password },
                    callOptions(),
                  ),
                phase: "wrong-key Administrator sign in",
              });
              const wrongKeyToken = wrongKeySignIn.credential?.token;
              if (wrongKeyToken === undefined || wrongKeyToken.length === 0) {
                return yield* Effect.die(new Error("expected a wrong-key process credential"));
              }
              secrecySentinels.push({
                name: "wrong-key Administrator bearer token",
                value: wrongKeyToken,
              });
              const runNamaWithWrongMasterKey = createNamaRunner(
                binary,
                cliEnvironment(home, wrongKeyToken),
              );
              const wrongKeyGet = yield* runNamaWithWrongMasterKey([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(wrongKeyGet);
              expectNamaSuccess(wrongKeyGet);
              expect(providerInstanceFromNama(wrongKeyGet)).toMatchObject({
                id: providerInstanceId,
                revision: createdRevision,
                status: "unavailable",
              });
              const wrongKeyUpdateArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                createdRevision,
                "--configuration",
                "-",
                "--operation-id",
                "wrong-key-rebind",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(wrongKeyUpdateArguments);
              const wrongKeyUpdate = yield* runNamaWithWrongMasterKey(
                wrongKeyUpdateArguments,
                JSON.stringify({ api_key: jellyfin.replacementApiKey }),
              );
              cliResults.push(wrongKeyUpdate);
              expectNamaFailure(
                wrongKeyUpdate,
                7,
                "provider_credentials_unavailable",
                nonPublicSentinels(),
              );
              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                port,
                processes,
              });
              const recoveredGet = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(recoveredGet);
              expectNamaSuccess(recoveredGet);
              expect(providerInstanceFromNama(recoveredGet)).toEqual(createdInstance);

              const replacementPatch = JSON.stringify({
                api_key: jellyfin.replacementApiKey,
                base_url: jellyfin.baseUrl.replace(/\/$/u, ""),
              });
              const updateArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                createdRevision,
                "--configuration",
                "-",
                "--operation-id",
                CREATE_OPERATION_ID,
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(updateArguments);
              const updated = yield* runNama(updateArguments, replacementPatch);
              cliResults.push(updated);
              expectNamaSuccess(updated);
              const updatedInstance = providerInstanceFromNama(updated);
              expect(updatedInstance).toMatchObject({
                configuration: {
                  base_url: jellyfin.baseUrl.replace(/\/$/u, ""),
                  user_id: jellyfin.primaryUserId,
                },
                configured_secrets: [{ configured: true, key: "api_key" }],
                enabled: true,
                status: "unavailable",
              });
              const updatedRevision = requiredString(updatedInstance, "revision");
              expect(updatedRevision).not.toBe(createdRevision);
              const durableUpdated =
                yield* readInstanceScopedProviderStateWithGlobalOperationResults(
                  databaseUrl,
                  providerInstanceId,
                );
              expect(durableUpdated.instanceScopedCredentials).not.toEqual(
                durableCreated.instanceScopedCredentials,
              );
              yield* revokeJellyfinCredential(jellyfin);

              const changedPrincipalArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                updatedRevision,
                "--configuration",
                "-",
                "--operation-id",
                "changed-provider-principal",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(changedPrincipalArguments);
              const changedPrincipal = yield* runNama(
                changedPrincipalArguments,
                JSON.stringify({ user_id: jellyfin.otherUserId }),
              );
              cliResults.push(changedPrincipal);
              expectNamaFailure(changedPrincipal, 6, "provider_user_changed", nonPublicSentinels());

              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                port,
                processes,
              });
              const updateRetry = yield* runNama(updateArguments, replacementPatch);
              cliResults.push(updateRetry);
              expectNamaSuccess(updateRetry);
              expect(updateRetry.stdout).toBe(updated.stdout);
              const conflictingUpdate = yield* runNama(
                updateArguments,
                JSON.stringify({ api_key: jellyfin.primaryApiKey }),
              );
              cliResults.push(conflictingUpdate);
              expectNamaFailure(
                conflictingUpdate,
                6,
                "idempotency_key_reused",
                nonPublicSentinels(),
              );
              const persistedCredentialVerificationArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                updatedRevision,
                "--configuration",
                "-",
                "--operation-id",
                "restarted-persisted-credential-verification",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(persistedCredentialVerificationArguments);
              const persistedCredentialVerification = yield* runNama(
                persistedCredentialVerificationArguments,
                JSON.stringify({ base_url: jellyfin.baseUrl.replace(/\/$/u, "") }),
              );
              cliResults.push(persistedCredentialVerification);
              expectNamaSuccess(persistedCredentialVerification);
              const persistedCredentialInstance = providerInstanceFromNama(
                persistedCredentialVerification,
              );
              expect(persistedCredentialInstance).toMatchObject({
                configuration: {
                  base_url: jellyfin.baseUrl.replace(/\/$/u, ""),
                  user_id: jellyfin.primaryUserId,
                },
                configured_secrets: [{ configured: true, key: "api_key" }],
                enabled: true,
              });
              const persistedCredentialRevision = requiredString(
                persistedCredentialInstance,
                "revision",
              );
              expect(persistedCredentialRevision).not.toBe(updatedRevision);

              const disabledUserCreateArguments = [
                "provider",
                "instance",
                "create",
                PROVIDER_TYPE_ID,
                "--display-name",
                "Disabled Jellyfin User",
                "--configuration",
                "-",
                "--operation-id",
                "disabled-jellyfin-user",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(disabledUserCreateArguments);
              const disabledUserCreate = yield* runNama(
                disabledUserCreateArguments,
                JSON.stringify({
                  api_key: jellyfin.replacementApiKey,
                  base_url: jellyfin.baseUrl,
                  user_id: jellyfin.disabledUserId,
                }),
              );
              cliResults.push(disabledUserCreate);
              expectNamaFailure(
                disabledUserCreate,
                6,
                "provider_incompatible",
                nonPublicSentinels(),
              );

              const damagedConfiguration = JSON.stringify({
                api_key: jellyfin.replacementApiKey,
                base_url: jellyfin.baseUrl,
                user_id: jellyfin.primaryUserId,
              });
              const damagedCreateArguments = [
                "provider",
                "instance",
                "create",
                PROVIDER_TYPE_ID,
                "--display-name",
                "Damaged Credential Instance",
                "--sync-priority",
                "2",
                "--configuration",
                "-",
                "--operation-id",
                "damaged-provider-instance",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(damagedCreateArguments);
              const damagedCreated = yield* runNama(damagedCreateArguments, damagedConfiguration);
              cliResults.push(damagedCreated);
              expectNamaSuccess(damagedCreated);
              const damagedInstance = providerInstanceFromNama(damagedCreated);
              const damagedInstanceId = requiredString(damagedInstance, "id");
              const damagedRevision = requiredString(damagedInstance, "revision");

              const firstPage = yield* runNama([
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
              cliResults.push(firstPage);
              expectNamaSuccess(firstPage);
              const firstPageData = dataFromNama(firstPage);
              const pageToken = requiredString(firstPageData, "next_page_token");
              const lastTokenCharacter = pageToken.at(-1);
              if (lastTokenCharacter === undefined) {
                return yield* Effect.die(new Error("expected a pagination token"));
              }
              let replacementTokenCharacter = "A";
              if (lastTokenCharacter === "A") {
                replacementTokenCharacter = "B";
              }
              const tamperedToken = `${pageToken.slice(0, -1)}${replacementTokenCharacter}`;
              const tamperedPage = yield* runNama([
                "provider",
                "instance",
                "list",
                "--page-size",
                "1",
                "--page-token",
                tamperedToken,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(tamperedPage);
              expectNamaFailure(tamperedPage, 2, "page_token_invalid", nonPublicSentinels());
              const crossMethodPage = yield* runNama([
                "provider",
                "type",
                "list",
                "--page-size",
                "1",
                "--page-token",
                pageToken,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(crossMethodPage);
              expectNamaFailure(crossMethodPage, 2, "page_token_invalid", nonPublicSentinels());
              const crossSizePage = yield* runNama([
                "provider",
                "instance",
                "list",
                "--page-size",
                "2",
                "--page-token",
                pageToken,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(crossSizePage);
              expectNamaFailure(crossSizePage, 2, "page_token_invalid", nonPublicSentinels());

              yield* stopCleanly(runningProcess);
              yield* withPool(databaseUrl, (pool) =>
                Effect.promise(() =>
                  pool.query(
                    "UPDATE provider_credential SET authentication_tag = set_byte(authentication_tag, 0, get_byte(authentication_tag, 0) # 255) WHERE provider_instance_id = $1",
                    [damagedInstanceId],
                  ),
                ),
              );
              runningProcess = yield* startProcess(databaseUrl, port);
              processes.push(runningProcess);
              yield* expectReady(runningProcess);
              const healthyAfterDamage = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(healthyAfterDamage);
              expectNamaSuccess(healthyAfterDamage);
              expect(providerInstanceFromNama(healthyAfterDamage)).toEqual(
                persistedCredentialInstance,
              );
              const healthyMutationArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                persistedCredentialRevision,
                "--configuration",
                "-",
                "--operation-id",
                "healthy-provider-beside-damaged-instance",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(healthyMutationArguments);
              const healthyMutation = yield* runNama(
                healthyMutationArguments,
                JSON.stringify({ base_url: jellyfin.baseUrl }),
              );
              cliResults.push(healthyMutation);
              expectNamaSuccess(healthyMutation);
              const healthyAfterDamageRevision = requiredString(
                providerInstanceFromNama(healthyMutation),
                "revision",
              );
              expect(healthyAfterDamageRevision).not.toBe(persistedCredentialRevision);
              const damagedGet = yield* runNama([
                "provider",
                "instance",
                "get",
                damagedInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(damagedGet);
              expectNamaSuccess(damagedGet);
              expect(providerInstanceFromNama(damagedGet)).toMatchObject({
                configured_secrets: [{ configured: true, key: "api_key" }],
                id: damagedInstanceId,
                revision: damagedRevision,
                status: "unavailable",
              });
              const availableAuthentication = yield* expectRpcSuccess({
                invoke: () => clientsFor(runningProcess.origin).setup.getStatus({}, callOptions()),
                phase: "credential-damage GetStatus",
              });
              expect(availableAuthentication.initialized).toBe(true);

              const disableDamagedArguments = [
                "provider",
                "instance",
                "update",
                damagedInstanceId,
                "--expected-revision",
                damagedRevision,
                "--enabled=false",
                "--operation-id",
                "disable-damaged-provider",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              const damagedDisabled = yield* runNama(disableDamagedArguments);
              cliResults.push(damagedDisabled);
              expectNamaSuccess(damagedDisabled);
              const damagedDisabledRevision = requiredString(
                providerInstanceFromNama(damagedDisabled),
                "revision",
              );
              const deleteDamagedArguments = [
                "provider",
                "instance",
                "delete",
                damagedInstanceId,
                "--expected-revision",
                damagedDisabledRevision,
                "--operation-id",
                "delete-damaged-provider",
                "--yes",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              const damagedDeleted = yield* runNama(deleteDamagedArguments);
              cliResults.push(damagedDeleted);
              expectNamaSuccess(damagedDeleted);

              const disableArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                healthyAfterDamageRevision,
                "--enabled=false",
                "--operation-id",
                "disable-durable-provider",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              const disabled = yield* runNama(disableArguments);
              cliResults.push(disabled);
              expectNamaSuccess(disabled);
              const disabledInstance = providerInstanceFromNama(disabled);
              expect(disabledInstance).toMatchObject({ enabled: false, status: "disabled" });
              const disabledRevision = requiredString(disabledInstance, "revision");

              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                port,
                processes,
              });
              const restartedDisabled = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(restartedDisabled);
              expectNamaSuccess(restartedDisabled);
              expect(providerInstanceFromNama(restartedDisabled)).toEqual(disabledInstance);

              const reenableArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                disabledRevision,
                "--enabled=true",
                "--operation-id",
                "reenable-durable-provider",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              const reenabled = yield* runNama(reenableArguments);
              cliResults.push(reenabled);
              expectNamaSuccess(reenabled);
              const reenabledInstance = providerInstanceFromNama(reenabled);
              expect(reenabledInstance).toMatchObject({ enabled: true, status: "unavailable" });
              const reenabledRevision = requiredString(reenabledInstance, "revision");
              const disableForDeletionArguments = [
                "provider",
                "instance",
                "update",
                providerInstanceId,
                "--expected-revision",
                reenabledRevision,
                "--enabled=false",
                "--operation-id",
                "disable-for-deletion",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              const disabledForDeletion = yield* runNama(disableForDeletionArguments);
              cliResults.push(disabledForDeletion);
              expectNamaSuccess(disabledForDeletion);
              const deletionRevision = requiredString(
                providerInstanceFromNama(disabledForDeletion),
                "revision",
              );
              const deleteArguments = [
                "provider",
                "instance",
                "delete",
                providerInstanceId,
                "--expected-revision",
                deletionRevision,
                "--operation-id",
                CREATE_OPERATION_ID,
                "--yes",
                "--profile",
                "local",
                "--output",
                "json",
              ] as const;
              providerArguments.push(deleteArguments);
              const deleted = yield* runNama(deleteArguments);
              cliResults.push(deleted);
              expectNamaSuccess(deleted);
              expect(dataFromNama(deleted)).toEqual({ operation_id: CREATE_OPERATION_ID });

              runningProcess = yield* restartProcess({
                currentProcess: runningProcess,
                databaseUrl,
                port,
                processes,
              });
              const deleteRetry = yield* runNama(deleteArguments);
              cliResults.push(deleteRetry);
              expectNamaSuccess(deleteRetry);
              expect(deleteRetry.stdout).toBe(deleted.stdout);
              const missingGet = yield* runNama([
                "provider",
                "instance",
                "get",
                providerInstanceId,
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(missingGet);
              expectNamaFailure(missingGet, 5, "resource_not_found", nonPublicSentinels());
              const retainedProviderType = yield* runNama([
                "provider",
                "type",
                "list",
                "--profile",
                "local",
                "--output",
                "json",
              ]);
              cliResults.push(retainedProviderType);
              expectNamaSuccess(retainedProviderType);
              expect(dataFromNama(retainedProviderType)).toMatchObject({
                provider_types: [{ id: PROVIDER_TYPE_ID, schema_revision: "1" }],
              });

              const deletedState = yield* readInstanceScopedProviderStateWithGlobalOperationResults(
                databaseUrl,
                providerInstanceId,
              );
              expect(deletedState.instanceScopedInstances).toEqual([]);
              expect(deletedState.instanceScopedCredentials).toEqual([]);
              expect(deletedState.instanceScopedObservations).toEqual([]);
              expect(deletedState.globalOperationResults.length).toBeGreaterThanOrEqual(7);
              expectSentinelsAbsent([
                {
                  contents: [JSON.stringify(deletedState.globalOperationResults)],
                  sentinels: secrecySentinels,
                },
              ]);

              expectSentinelsAbsent([
                {
                  contents: cliResults.flatMap((result) => [result.stdout, result.stderr]),
                  sentinels: secrecySentinels,
                },
                {
                  contents: cliResults
                    .filter((result) => result.exitCode !== 0)
                    .flatMap((result) => [result.stdout, result.stderr]),
                  sentinels: nonPublicSentinels(),
                },
                { contents: diagnosticResponses, sentinels: nonPublicSentinels() },
                { contents: diagnosticMetadata, sentinels: nonPublicSentinels() },
              ]);
              expectSentinelsAbsent([
                {
                  contents: processes.flatMap((process) => [process.stdout(), process.stderr()]),
                  sentinels: nonPublicSentinels(),
                },
              ]);
              expectSentinelsAbsent([
                {
                  contents: providerArguments.map((arguments_) => JSON.stringify(arguments_)),
                  sentinels: nonPublicSentinels(),
                },
              ]);
              yield* stopCleanly(runningProcess);
              return yield* Effect.void;
            }),
          ),
        ),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
