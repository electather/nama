// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary, typescript/no-unsafe-type-assertion -- Provider-management fixtures keep reconciliation outcomes and token-boundary assertions explicit.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type {
  ProviderInstallationInput,
  ProviderPersistence,
} from "../../database/provider-persistence.ts";
import { unusedProviderPersistence } from "../../database/tests/provider-persistence.test-support.ts";
import { PluginUnavailable } from "../../plugin/errors.ts";
import type { PluginSupervisorService } from "../../plugin/model.ts";
import { makeProviderManagement } from "../provider-management.ts";

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

const successfulSupervisor = Object.freeze({
  supervise: () =>
    Effect.succeed({
      call: () => Effect.succeed({ pluginInfo: discoveredPluginInfo }),
    }),
}) as unknown as PluginSupervisorService;

const unavailableSupervisor = Object.freeze({
  supervise: () => Effect.fail(new PluginUnavailable({ reason: "plugin_exited" })),
}) as unknown as PluginSupervisorService;

const incompatibleSupervisor = Object.freeze({
  supervise: () => Effect.fail(new PluginUnavailable({ reason: "contract_unsupported" })),
}) as unknown as PluginSupervisorService;

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
    listInstallationInstanceIds: () => Effect.succeed([]),
    listInstallations: () => Effect.succeed(installation === undefined ? [] : [installation]),
    loadInstallation: () => Effect.succeed(installation),
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
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
        supervisor: successfulSupervisor,
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
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
        supervisor: successfulSupervisor,
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
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
        supervisor: incompatibleSupervisor,
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
    listInstallationInstanceIds: () => Effect.succeed(["instance-invalid"]),
    loadInstance: () =>
      Effect.succeed({
        configuration: { base_url: 42 },
        credentials: { api_key: "credential" },
        displayName: "Invalid instance",
        enabled: true,
        id: "instance-invalid",
        providerTypeId: "jellyfin",
        revision: "revision-1",
        syncPriority: 1,
      }),
  } satisfies ProviderPersistence;
  return Effect.scoped(
    Effect.gen(function* storedInstanceCompatibilityTest() {
      yield* makeProviderManagement({
        masterKey: MASTER_KEY,
        persistence: providers,
        supervisor: successfulSupervisor,
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
        masterKey: MASTER_KEY,
        persistence: persistence.providers,
        supervisor: unavailableSupervisor,
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
    listInstallationInstanceIds: () => Effect.succeed([]),
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
  } satisfies ProviderPersistence;
  return Effect.scoped(
    Effect.gen(function* paginatedProviderTypesTest() {
      const service = yield* makeProviderManagement({
        masterKey: MASTER_KEY,
        persistence: providers,
        supervisor: successfulSupervisor,
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
      const tampered = `${firstPage.nextPageToken.slice(0, -1)}A`;
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
