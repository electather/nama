// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Provider-management fixtures keep reconciliation, secret splitting, candidate admission, and token-boundary assertions explicit.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

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
