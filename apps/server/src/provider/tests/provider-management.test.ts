// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Provider-management fixtures keep reconciliation, secret splitting, candidate admission, and token-boundary assertions explicit.
import { expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import type {
  ProviderInstallationInput,
  ProviderPersistence,
} from "../../database/provider-persistence.ts";
import { unusedProviderPersistence } from "../../database/tests/provider-persistence.test-support.ts";
import { PluginUnavailable } from "../../plugin/errors.ts";
import { makeProviderManagement } from "../provider-management.ts";
import type { ProviderDiscovery } from "../provider-management.ts";

const MASTER_KEY = `base64:${Buffer.alloc(32, 11).toString("base64")}`;
const jellyfinSchema = {
  additionalProperties: false,
  properties: {
    api_key: {
      format: "password",
      maxLength: 4096,
      minLength: 1,
      type: "string",
      writeOnly: true,
    },
    base_url: { format: "uri", maxLength: 2048, minLength: 1, type: "string" },
    optional_note: { maxLength: 128, minLength: 1, type: "string" },
    user_id: { maxLength: 128, minLength: 1, type: "string" },
  },
  required: ["base_url", "user_id", "api_key"],
  type: "object",
} as const;
const discoveredPluginInfo = Object.freeze({
  buildVersion: "0.0.0-dev",
  capabilities: [],
  configurationSchema: jellyfinSchema,
  contractMajor: 1,
  description: "Connect Nama to a Jellyfin server.",
  displayName: "Jellyfin",
  providerTypeId: "jellyfin",
  schemaProfileVersion: 1,
  schemaRevision: "1",
});

const successfulDiscovery = (() =>
  Effect.succeed(discoveredPluginInfo)) satisfies ProviderDiscovery;

const unavailableDiscovery = (() =>
  Effect.fail(new PluginUnavailable({ reason: "plugin_exited" }))) satisfies ProviderDiscovery;

const incompatibleDiscovery = (() =>
  Effect.fail(
    new PluginUnavailable({ reason: "contract_unsupported" }),
  )) satisfies ProviderDiscovery;

const noOperationResult: ProviderPersistence["readOperationResult"] = () =>
  // oxlint-disable-next-line unicorn/no-useless-undefined -- The fixture must explicitly model an absent operation result.
  Effect.succeed(undefined);

const makePersistence = (initial?: ProviderInstallationInput) => {
  let installation = initial;
  let accepted = 0;
  const providers = {
    ...unusedProviderPersistence,
    acceptInstallation: (input: ProviderInstallationInput) =>
      Effect.sync(() => {
        accepted += 1;
        installation = input;
      }),
    listInstallations: () => Effect.succeed(installation === undefined ? [] : [installation]),
    loadInstallation: () => Effect.succeed(installation),
    loadInstallationConfigurations: () => Effect.succeed([]),
  } satisfies ProviderPersistence;
  return {
    accepted: () => accepted,
    installation: () => installation,
    providers,
  };
};

it.effect("reconciles valid discovery metadata and lists its accepted schema", () => {
  const persistence = makePersistence();
  return Effect.scoped(
    Effect.gen(function* successfulReconciliationTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
      });
      const page = yield* service.listProviderTypes({
        administratorId: "administrator-a",
        pageSize: 0,
        pageToken: "",
      });

      expect(persistence.accepted()).toBe(1);
      expect(page.nextPageToken).toBe("");
      expect(page.providerTypes).toEqual([persistence.installation()]);
    }),
  );
});

it.effect("preserves the last accepted schema when discovery is incompatible", () => {
  const previous: ProviderInstallationInput = {
    capabilities: [],
    configurationSchema: {
      ...jellyfinSchema,
      properties: {
        ...jellyfinSchema.properties,
        legacy: { type: "string" },
      },
      required: [...jellyfinSchema.required, "legacy"],
    },
    contractMajor: 1,
    description: "Previously accepted Jellyfin provider",
    displayName: "Jellyfin",
    pluginBuildVersion: "previous",
    providerTypeId: "jellyfin",
    schemaProfileVersion: 1,
    schemaRevision: "previous",
  };
  const persistence = makePersistence(previous);
  return Effect.scoped(
    Effect.gen(function* incompatibleReconciliationTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
      });
      const page = yield* service.listProviderTypes({
        administratorId: "administrator-a",
        pageSize: 50,
        pageToken: "",
      });

      expect(persistence.accepted()).toBe(0);
      expect(page.providerTypes).toEqual([previous]);
    }),
  );
});

it.effect("reports an incompatible private contract without replacing accepted metadata", () => {
  const previous: ProviderInstallationInput = {
    capabilities: [],
    configurationSchema: jellyfinSchema,
    contractMajor: 1,
    description: "Previously accepted Jellyfin provider",
    displayName: "Jellyfin",
    pluginBuildVersion: "previous",
    providerTypeId: "jellyfin",
    schemaProfileVersion: 1,
    schemaRevision: "1",
  };
  const persistence = makePersistence(previous);
  return Effect.scoped(
    Effect.gen(function* incompatibleContractTest() {
      yield* makeProviderManagement({
        discover: incompatibleDiscovery,
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
      });

      expect(persistence.accepted()).toBe(0);
      expect(persistence.installation()).toEqual(previous);
    }),
  );
});

it.effect("preserves accepted metadata when a stored instance fails the discovered schema", () => {
  const previous: ProviderInstallationInput = {
    capabilities: [],
    configurationSchema: jellyfinSchema,
    contractMajor: 1,
    description: "Previously accepted Jellyfin provider",
    displayName: "Jellyfin",
    pluginBuildVersion: "previous",
    providerTypeId: "jellyfin",
    schemaProfileVersion: 1,
    schemaRevision: "previous",
  };
  const persistence = makePersistence(previous);
  const providers = {
    ...persistence.providers,
    loadInstallationConfigurations: () =>
      Effect.succeed([
        {
          api_key: "credential",
          base_url: 42,
          user_id: "user",
        },
      ]),
  } satisfies ProviderPersistence;
  return Effect.scoped(
    Effect.gen(function* storedInstanceCompatibilityTest() {
      yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
      });

      expect(persistence.accepted()).toBe(0);
      expect(persistence.installation()).toEqual(previous);
    }),
  );
});

it.effect("contains plugin absence without changing another accepted installation", () => {
  const previous: ProviderInstallationInput = {
    capabilities: [],
    configurationSchema: jellyfinSchema,
    contractMajor: 1,
    description: "Previously accepted Jellyfin provider",
    displayName: "Jellyfin",
    pluginBuildVersion: "previous",
    providerTypeId: "jellyfin",
    schemaProfileVersion: 1,
    schemaRevision: "1",
  };
  const persistence = makePersistence(previous);
  return Effect.scoped(
    Effect.gen(function* unavailableReconciliationTest() {
      const service = yield* makeProviderManagement({
        discover: unavailableDiscovery,
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
      });
      const page = yield* service.listProviderTypes({
        administratorId: "administrator-a",
        pageSize: 50,
        pageToken: "",
      });

      expect(persistence.accepted()).toBe(0);
      expect(page.providerTypes).toEqual([previous]);
    }),
  );
});

it.effect("binds provider list continuations to administrator, page size, and cursor", () => {
  const alpha: ProviderInstallationInput = {
    capabilities: [],
    configurationSchema: jellyfinSchema,
    contractMajor: 1,
    description: "Alpha provider",
    displayName: "Alpha",
    pluginBuildVersion: "alpha",
    providerTypeId: "alpha",
    schemaProfileVersion: 1,
    schemaRevision: "1",
  };
  const installations: ProviderInstallationInput[] = [alpha];
  const providers = {
    ...unusedProviderPersistence,
    acceptInstallation: (input: ProviderInstallationInput) =>
      Effect.sync(() => {
        installations.push(input);
        installations.sort((left, right) =>
          left.providerTypeId.localeCompare(right.providerTypeId),
        );
      }),
    listInstallations: (input: {
      readonly afterProviderTypeId?: string;
      readonly limit: number;
      readonly providerTypeIds: readonly string[];
    }) =>
      Effect.sync(() =>
        installations
          .filter(
            ({ providerTypeId }) =>
              input.afterProviderTypeId === undefined || providerTypeId > input.afterProviderTypeId,
          )
          .slice(0, input.limit),
      ),
    loadInstallation: (providerTypeId: string) =>
      Effect.succeed(
        installations.find((installation) => installation.providerTypeId === providerTypeId),
      ),
    loadInstallationConfigurations: () => Effect.succeed([]),
  } satisfies ProviderPersistence;
  return Effect.scoped(
    Effect.gen(function* paginatedProviderTypesTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
      });
      const firstPage = yield* service.listProviderTypes({
        administratorId: "administrator-a",
        pageSize: 1,
        pageToken: "",
      });
      expect(firstPage.providerTypes.map(({ providerTypeId }) => providerTypeId)).toEqual([
        "alpha",
      ]);
      expect(firstPage.nextPageToken).not.toBe("");

      const secondPage = yield* service.listProviderTypes({
        administratorId: "administrator-a",
        pageSize: 1,
        pageToken: firstPage.nextPageToken,
      });
      expect(secondPage.providerTypes.map(({ providerTypeId }) => providerTypeId)).toEqual([
        "jellyfin",
      ]);
      const crossAdministrator = yield* service
        .listProviderTypes({
          administratorId: "administrator-b",
          pageSize: 1,
          pageToken: firstPage.nextPageToken,
        })
        .pipe(Effect.flip);
      expect(crossAdministrator).toMatchObject({ _tag: "PageTokenInvalid" });
      const crossPageSize = yield* service
        .listProviderTypes({
          administratorId: "administrator-a",
          pageSize: 2,
          pageToken: firstPage.nextPageToken,
        })
        .pipe(Effect.flip);
      expect(crossPageSize).toMatchObject({ _tag: "PageTokenInvalid" });
      const replacement = firstPage.nextPageToken.endsWith("A") ? "B" : "A";
      const tampered = `${firstPage.nextPageToken.slice(0, -1)}${replacement}`;
      const tampering = yield* service
        .listProviderTypes({
          administratorId: "administrator-a",
          pageSize: 1,
          pageToken: tampered,
        })
        .pipe(Effect.flip);
      expect(tampering).toMatchObject({ _tag: "PageTokenInvalid" });
    }),
  );
});

it.effect("splits write-only configuration and returns an idempotent safe instance", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  let persistedCredentials: Readonly<Record<string, string>> = {};
  const serializedResult: {
    result?: Readonly<Record<string, unknown>>;
  } = {};
  const providers = {
    ...persistence.providers,
    createInstance: (input: Parameters<ProviderPersistence["createInstance"]>[0]) =>
      Effect.sync(() => {
        persistedCredentials = input.credentials;
        const instance = {
          configuration: input.configuration,
          configuredSecretKeys: Object.keys(input.credentials),
          createdAt,
          credentialsAvailable: true,
          displayName: input.displayName,
          enabled: input.enabled,
          id: input.id,
          observation: input.observation,
          providerTypeId: input.providerTypeId,
          revision: input.revision,
          syncPriority: input.syncPriority ?? 1,
          updatedAt: createdAt,
        };
        const result = input.operation.serializeResult?.(instance);
        if (result !== undefined) {
          serializedResult.result = result;
        }
        return instance;
      }),
    readOperationResult: noOperationResult,
  } satisfies ProviderPersistence;
  return Effect.scoped(
    Effect.gen(function* createProviderInstanceTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () =>
          Effect.succeed({ principalReference: "jellyfin-provider-principal" }),
      });
      const created = yield* service.createProviderInstance({
        administratorId: "administrator-a",
        configuration: {
          api_key: "credential-sentinel",
          base_url: "http://127.0.0.1:8096",
          user_id: "provider-user",
        },
        displayName: "Home",
        enabled: true,
        operationId: "create-operation",
        providerTypeId: "jellyfin",
      });

      expect(created.configuration).toEqual({
        base_url: "http://127.0.0.1:8096",
        user_id: "provider-user",
      });
      expect(persistedCredentials).toEqual({ api_key: "credential-sentinel" });
      expect(serializedResult.result).not.toContain("credential-sentinel");
      expect(created.configuredSecretKeys).toEqual(["api_key"]);
    }),
  );
});

it.effect("rejects Jellyfin UTF-8 bounds before launching a candidate", () => {
  const persistence = makePersistence();
  const providers = {
    ...persistence.providers,
    readOperationResult: noOperationResult,
  } satisfies ProviderPersistence;
  let candidateCalls = 0;
  return Effect.scoped(
    Effect.gen(function* providerConfigurationBoundsTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () =>
          Effect.sync(() => {
            candidateCalls += 1;
            return { principalReference: "unexpected" };
          }),
      });
      const invalidConfigurations = [
        {
          api_key: "credential",
          base_url: "é".repeat(1025),
          user_id: "provider-user",
        },
        {
          api_key: "credential",
          base_url: "http://127.0.0.1:8096",
          user_id: "u".repeat(129),
        },
        {
          api_key: "é".repeat(2049),
          base_url: "http://127.0.0.1:8096",
          user_id: "provider-user",
        },
      ];
      for (const [index, configuration] of invalidConfigurations.entries()) {
        const failure = yield* service
          .createProviderInstance({
            administratorId: "administrator-a",
            configuration,
            displayName: "Home",
            enabled: true,
            operationId: `invalid-${String(index)}`,
            providerTypeId: "jellyfin",
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "ProviderValidationFailed" });
      }

      expect(candidateCalls).toBe(0);
    }),
  );
});

it.effect("updates metadata without verifying a provider candidate", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  let candidateCalls = 0;
  const persistedUpdate: { value?: Parameters<ProviderPersistence["updateInstance"]>[0] } = {};
  const providers = {
    ...persistence.providers,
    loadInstanceRecord: () => Effect.succeed(current),
    readOperationResult: noOperationResult,
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) =>
      Effect.sync(() => {
        persistedUpdate.value = input;
        return {
          ...current,
          displayName: input.displayName,
          revision: input.revision,
          syncPriority: input.syncPriority,
          updatedAt: new Date("2026-08-19T12:01:00.000Z"),
        };
      }),
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* updateMetadataTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () =>
          Effect.sync(() => {
            candidateCalls += 1;
            return { principalReference: "unexpected" };
          }),
      });
      const updated = yield* service.updateProviderInstance({
        administratorId: "administrator-a",
        clearConfigurationFields: [],
        configurationPatch: {},
        displayName: "Family Room",
        expectedRevision: "revision-1",
        operationId: "update-operation",
        providerInstanceId: "provider-instance",
        syncPriority: 2,
      });

      expect(updated).toMatchObject({
        displayName: "Family Room",
        syncPriority: 2,
      });
      expect(updated.revision).not.toBe("revision-1");
      expect(candidateCalls).toBe(0);
      expect(persistedUpdate.value).toMatchObject({
        credentialChanges: {},
        displayName: "Family Room",
        enabled: true,
        expectedRevision: "revision-1",
        providerInstanceId: "provider-instance",
        syncPriority: 2,
      });
      expect(Object.hasOwn(persistedUpdate.value ?? {}, "configuration")).toBe(false);
    }),
  );
});

it.effect("re-enables a patched instance with its retained credential and principal", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: false,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const persistedUpdate: { value?: Parameters<ProviderPersistence["updateInstance"]>[0] } = {};
  const providers = {
    ...persistence.providers,
    loadInstance: () =>
      Effect.succeed({
        configuration: current.configuration,
        credentials: { api_key: "retained-credential" },
        displayName: current.displayName,
        enabled: current.enabled,
        id: current.id,
        providerTypeId: current.providerTypeId,
        revision: current.revision,
        syncPriority: current.syncPriority,
      }),
    loadInstanceRecord: () => Effect.succeed(current),
    matchesPrincipal: (_providerInstanceId: string, principalReference: string) =>
      Effect.succeed(principalReference === "same-principal"),
    readOperationResult: noOperationResult,
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) =>
      Effect.sync(() => {
        persistedUpdate.value = input;
        return {
          ...current,
          configuration: input.configuration ?? current.configuration,
          enabled: input.enabled,
          revision: input.revision,
          updatedAt: new Date("2026-08-19T12:01:00.000Z"),
        };
      }),
  } satisfies ProviderPersistence;
  const candidateInputs: Readonly<{
    configuration: Readonly<Record<string, unknown>>;
    credentials: Readonly<Record<string, string>>;
  }>[] = [];

  return Effect.scoped(
    Effect.gen(function* reenablePatchedInstanceTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: (_provider, configuration, credentials) =>
          Effect.sync(() => {
            candidateInputs.push({ configuration, credentials });
            return { principalReference: "same-principal" };
          }),
      });
      const updated = yield* service.updateProviderInstance({
        administratorId: "administrator-a",
        clearConfigurationFields: [],
        configurationPatch: { base_url: "http://127.0.0.1:9096" },
        enabled: true,
        expectedRevision: "revision-1",
        operationId: "reenable-operation",
        providerInstanceId: "provider-instance",
      });

      expect(updated).toMatchObject({
        configuration: { base_url: "http://127.0.0.1:9096", user_id: "provider-user" },
        enabled: true,
      });
      expect(candidateInputs).toEqual([
        {
          configuration: {
            base_url: "http://127.0.0.1:9096",
            user_id: "provider-user",
          },
          credentials: { api_key: "retained-credential" },
        },
      ]);
      expect(persistedUpdate.value).toMatchObject({
        clearCredentialKeys: [],
        configuration: {
          base_url: "http://127.0.0.1:9096",
          user_id: "provider-user",
        },
        credentialChanges: {},
        enabled: true,
      });
    }),
  );
});

it.effect("rejects a credential replacement that changes the provider principal", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const providers = {
    ...persistence.providers,
    loadInstance: () =>
      Effect.succeed({
        configuration: current.configuration,
        credentials: { api_key: "existing-credential" },
        displayName: current.displayName,
        enabled: current.enabled,
        id: current.id,
        providerTypeId: current.providerTypeId,
        revision: current.revision,
        syncPriority: current.syncPriority,
      }),
    loadInstanceRecord: () => Effect.succeed(current),
    matchesPrincipal: () => Effect.succeed(false),
    readOperationResult: noOperationResult,
  } satisfies ProviderPersistence;
  let verifiedCredentials: Readonly<Record<string, string>> = {};

  return Effect.scoped(
    Effect.gen(function* changedProviderPrincipalTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: (_provider, _configuration, credentials) =>
          Effect.sync(() => {
            verifiedCredentials = credentials;
            return { principalReference: "different-principal" };
          }),
      });
      const failure = yield* service
        .updateProviderInstance({
          administratorId: "administrator-a",
          clearConfigurationFields: [],
          configurationPatch: { api_key: "replacement-credential" },
          expectedRevision: "revision-1",
          operationId: "replacement-operation",
          providerInstanceId: "provider-instance",
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "ProviderUserChanged" });
      expect(verifiedCredentials).toEqual({ api_key: "replacement-credential" });
      expect(current.revision).toBe("revision-1");
    }),
  );
});

it.effect("retires runtime admission before committing a disable-only update", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const transitions: string[] = [];
  let candidateCalls = 0;
  const providers = {
    ...persistence.providers,
    loadInstanceRecord: () => Effect.succeed(current),
    readOperationResult: noOperationResult,
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) =>
      Effect.sync(() => {
        transitions.push("commit");
        return {
          ...current,
          enabled: input.enabled,
          revision: input.revision,
          updatedAt: new Date("2026-08-19T12:01:00.000Z"),
        };
      }),
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* disableInstanceTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        fenceInstance: (_providerInstanceId, retireCurrent) =>
          Effect.sync(() => {
            transitions.push(`fence:${String(retireCurrent)}`);
            return {
              open: (revision: string) =>
                Effect.sync(() => {
                  transitions.push(`open:${revision}`);
                }),
            };
          }),
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () =>
          Effect.sync(() => {
            candidateCalls += 1;
            return { principalReference: "unexpected" };
          }),
      });
      const disabled = yield* service.updateProviderInstance({
        administratorId: "administrator-a",
        clearConfigurationFields: [],
        configurationPatch: {},
        enabled: false,
        expectedRevision: "revision-1",
        operationId: "disable-operation",
        providerInstanceId: "provider-instance",
      });

      expect(disabled.enabled).toBe(false);
      expect(candidateCalls).toBe(0);
      expect(transitions).toEqual(["fence:true", "commit"]);
    }),
  );
});

it.effect("keeps an ambiguous instance update unavailable until durable recovery", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const taggedError = Data.TaggedError;
  const PersistenceUnavailable = taggedError("ProviderPersistenceError")<Record<string, never>>;
  let commitFailed = false;
  let databaseAvailable = true;
  let updateCalls = 0;
  const fenceRetireFlags: boolean[] = [];
  const openedRevisions: string[] = [];
  const providers = {
    ...persistence.providers,
    loadInstanceRecord: () =>
      databaseAvailable ? Effect.succeed(current) : Effect.fail(new PersistenceUnavailable({})),
    readOperationResult: (lookup) =>
      databaseAvailable ? noOperationResult(lookup) : Effect.fail(new PersistenceUnavailable({})),
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) => {
      updateCalls += 1;
      if (!commitFailed) {
        commitFailed = true;
        databaseAvailable = false;
        return Effect.fail(new PersistenceUnavailable({}));
      }
      return Effect.succeed({
        ...current,
        displayName: input.displayName,
        revision: input.revision,
        updatedAt: new Date("2026-08-19T12:01:00.000Z"),
      });
    },
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* ambiguousUpdateRecoveryTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        fenceInstance: (_providerInstanceId, retireCurrent) =>
          Effect.sync(() => {
            fenceRetireFlags.push(retireCurrent);
            return {
              open: (revision: string) =>
                Effect.sync(() => {
                  openedRevisions.push(revision);
                }),
            };
          }),
        masterKey: MASTER_KEY,
        persistence: providers,
      });
      const request = {
        administratorId: "administrator-a",
        clearConfigurationFields: [],
        configurationPatch: {},
        displayName: "Family",
        expectedRevision: "revision-1",
        operationId: "ambiguous-operation",
        providerInstanceId: "provider-instance",
      } as const;
      const failure = yield* service.updateProviderInstance(request).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "ProviderCommitAmbiguous" });
      expect(current).toMatchObject({ displayName: "Home", revision: "revision-1" });

      databaseAvailable = true;
      const recovered = yield* service.updateProviderInstance(request);
      expect(recovered).toMatchObject({ displayName: "Family" });
      expect(updateCalls).toBe(2);
      expect(fenceRetireFlags).toEqual([false, false]);
      expect(openedRevisions).toEqual([recovered.revision]);
    }),
  );
});

it.effect("clears an optional configuration field without clearing retained secrets", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      optional_note: "remove me",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const persistedUpdate: { value?: Parameters<ProviderPersistence["updateInstance"]>[0] } = {};
  const providers = {
    ...persistence.providers,
    loadInstance: () =>
      Effect.succeed({
        configuration: current.configuration,
        credentials: { api_key: "retained-credential" },
        displayName: current.displayName,
        enabled: current.enabled,
        id: current.id,
        providerTypeId: current.providerTypeId,
        revision: current.revision,
        syncPriority: current.syncPriority,
      }),
    loadInstanceRecord: () => Effect.succeed(current),
    matchesPrincipal: () => Effect.succeed(true),
    readOperationResult: noOperationResult,
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) =>
      Effect.sync(() => {
        persistedUpdate.value = input;
        return {
          ...current,
          configuration: input.configuration ?? current.configuration,
          revision: input.revision,
          updatedAt: new Date("2026-08-19T12:01:00.000Z"),
        };
      }),
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* clearOptionalConfigurationTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () => Effect.succeed({ principalReference: "same-principal" }),
      });
      const updated = yield* service.updateProviderInstance({
        administratorId: "administrator-a",
        clearConfigurationFields: ["optional_note"],
        configurationPatch: {},
        expectedRevision: "revision-1",
        operationId: "clear-operation",
        providerInstanceId: "provider-instance",
      });

      expect(updated.configuration).toEqual({
        base_url: "http://127.0.0.1:8096",
        user_id: "provider-user",
      });
      expect(persistedUpdate.value).toMatchObject({
        clearCredentialKeys: [],
        credentialChanges: {},
      });
    }),
  );
});

it.effect("leaves the durable snapshot unchanged when runtime cleanup fails", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  let commitCalls = 0;
  const providers = {
    ...persistence.providers,
    loadInstanceRecord: () => Effect.succeed(current),
    readOperationResult: noOperationResult,
    updateInstance: () =>
      Effect.sync(() => {
        commitCalls += 1;
        return current;
      }),
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* cleanupFailureTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        fenceInstance: () => Effect.fail(new PluginUnavailable({ reason: "plugin_exited" })),
        masterKey: MASTER_KEY,
        persistence: providers,
      });
      const failure = yield* service
        .updateProviderInstance({
          administratorId: "administrator-a",
          clearConfigurationFields: [],
          configurationPatch: {},
          enabled: false,
          expectedRevision: "revision-1",
          operationId: "disable-operation",
          providerInstanceId: "provider-instance",
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "ProviderPluginUnavailable" });
      expect(commitCalls).toBe(0);
      expect(current).toMatchObject({ enabled: true, revision: "revision-1" });
    }),
  );
});

it.effect("returns every update violation in deterministic field order", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      optional_note: "current",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  let candidateCalls = 0;
  const providers = {
    ...persistence.providers,
    loadInstance: () =>
      Effect.succeed({
        configuration: current.configuration,
        credentials: { api_key: "credential" },
        displayName: current.displayName,
        enabled: current.enabled,
        id: current.id,
        providerTypeId: current.providerTypeId,
        revision: current.revision,
        syncPriority: current.syncPriority,
      }),
    loadInstanceRecord: () => Effect.succeed(current),
    readOperationResult: noOperationResult,
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* completeUpdateValidationTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
        verifyCandidate: () =>
          Effect.sync(() => {
            candidateCalls += 1;
            return { principalReference: "unexpected" };
          }),
      });
      const failure = yield* service
        .updateProviderInstance({
          administratorId: "administrator-a",
          clearConfigurationFields: ["base_url"],
          configurationPatch: {
            base_url: 42,
            optional_note: 42,
          },
          expectedRevision: "revision-1",
          operationId: "invalid-update",
          providerInstanceId: "provider-instance",
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({
        _tag: "ProviderValidationFailed",
        violations: [
          { field: "clear_configuration_fields[0]", reason: "CONFLICT" },
          { field: "clear_configuration_fields[0]", reason: "UNSUPPORTED_VALUE" },
          { field: "configuration_patch.base_url", reason: "CONFLICT" },
          { field: "configuration_patch.optional_note", reason: "UNSUPPORTED_VALUE" },
        ],
      });
      expect(candidateCalls).toBe(0);
    }),
  );
});

it.effect("distinguishes an omitted display name from the literal absent", () => {
  const persistence = makePersistence();
  const createdAt = new Date("2026-08-19T12:00:00.000Z");
  const current = {
    configuration: {
      base_url: "http://127.0.0.1:8096",
      user_id: "provider-user",
    },
    configuredSecretKeys: ["api_key"],
    createdAt,
    credentialsAvailable: true,
    displayName: "Home",
    enabled: true,
    id: "provider-instance",
    observation: { status: "healthy" as const, summary: "Connected" },
    providerTypeId: "jellyfin",
    revision: "revision-1",
    syncPriority: 1,
    updatedAt: createdAt,
  };
  const taggedError = Data.TaggedError;
  const OperationKeyReused = taggedError("ProviderOperationKeyReused")<Record<string, never>>;
  const durableCanonicalRequest: { value?: Buffer } = {};
  const providers = {
    ...persistence.providers,
    loadInstanceRecord: () => Effect.succeed(current),
    readOperationResult: (lookup: Parameters<ProviderPersistence["readOperationResult"]>[0]) => {
      if (durableCanonicalRequest.value === undefined) {
        return noOperationResult(lookup);
      }
      if (durableCanonicalRequest.value.equals(lookup.canonicalRequest)) {
        return noOperationResult(lookup);
      }
      return Effect.fail(new OperationKeyReused({}));
    },
    updateInstance: (input: Parameters<ProviderPersistence["updateInstance"]>[0]) =>
      Effect.sync(() => {
        durableCanonicalRequest.value = Buffer.from(input.operation.canonicalRequest);
        return {
          ...current,
          enabled: input.enabled,
          revision: input.revision,
          updatedAt: new Date("2026-08-19T12:01:00.000Z"),
        };
      }),
  } satisfies ProviderPersistence;

  return Effect.scoped(
    Effect.gen(function* optionalPresenceIdempotencyTest() {
      const service = yield* makeProviderManagement({
        discover: successfulDiscovery,
        masterKey: MASTER_KEY,
        persistence: providers,
      });
      const request = {
        administratorId: "administrator-a",
        clearConfigurationFields: [],
        configurationPatch: {},
        enabled: false,
        expectedRevision: "revision-1",
        operationId: "presence-operation",
        providerInstanceId: "provider-instance",
      } as const;
      yield* service.updateProviderInstance(request);
      const failure = yield* service
        .updateProviderInstance({ ...request, displayName: "absent" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ _tag: "IdempotencyKeyReused" });
    }),
  );
});
