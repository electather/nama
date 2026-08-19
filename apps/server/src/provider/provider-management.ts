// oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements -- The deep provider-management owner keeps reconciliation and pagination transitions explicit.
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Clock, Context, Effect, Layer, Redacted } from "effect";
import type { Scope } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import type {
  ProviderInstallationListInput,
  ProviderPersistence,
  ProviderPersistenceFailure,
  StoredProviderInstallation,
} from "../database/provider-persistence.ts";
import type { PluginSupervisorService } from "../plugin/model.ts";
import { PluginSupervisor } from "../plugin/supervisor.ts";
import {
  bundledProviderTypeIds,
  bundledProviders,
  validateBundledProviderRegistry,
} from "./bundled-provider-registry.ts";
import { PageTokenInvalid, makePageTokenCodec } from "./page-token.ts";
import type { PageTokenCodec, PageTokenInvalidFailure } from "./page-token.ts";
import {
  configurationMatchesRestrictedSchema,
  isInstallationSchemaCompatible,
  normalizeDiscoveredPluginInfo,
} from "./restricted-schema.ts";

const ZERO = 0;
const LAST_ITEM = -1;
const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const NEXT_ROW = 1;
const PAGE_TOKEN_LIFETIME_MILLISECONDS = 900_000;
const LIST_PROVIDER_TYPES_METHOD = "nama.api.v1.ProviderService.ListProviderTypes";
const NORMALIZED_PROVIDER_TYPE_QUERY = "{}";
const DISCOVERY_DEADLINE_MILLISECONDS = 5000;

type ProviderDiscoveryStatus = "available" | "incompatible" | "unavailable";

interface ListProviderTypesInput {
  readonly administratorId: string;
  readonly pageSize: number;
  readonly pageToken: string;
}

interface ProviderTypeCursorInput {
  readonly input: ListProviderTypesInput;
  readonly now: number;
  readonly pageSize: number;
  readonly pageTokens: PageTokenCodec;
}

interface ListProviderTypesResult {
  readonly nextPageToken: string;
  readonly providerTypes: readonly StoredProviderInstallation[];
}

interface ProviderManagementService {
  readonly listProviderTypes: (
    input: ListProviderTypesInput,
  ) => Effect.Effect<ListProviderTypesResult, PageTokenInvalidFailure | ProviderPersistenceFailure>;
}

interface ProviderManagementDependencies {
  readonly masterKey: string;
  readonly persistence: ProviderPersistence;
  readonly supervisor: PluginSupervisorService;
}

const pageTokenFailure = (error: unknown): PageTokenInvalidFailure => {
  if (error instanceof PageTokenInvalid) {
    return error;
  }
  return new PageTokenInvalid({});
};

const discoverProvider = (
  supervisor: PluginSupervisorService,
  provider: (typeof bundledProviders)[number],
) =>
  Effect.scoped(
    supervisor.supervise(provider.descriptor, { kind: "discovery" }).pipe(
      Effect.flatMap((plugin) =>
        plugin.call(PluginService.method.getInfo, {}, DISCOVERY_DEADLINE_MILLISECONDS),
      ),
      Effect.map((response) => response.pluginInfo),
    ),
  );

const storedInstancesMatchSchema = (
  persistence: ProviderPersistence,
  installation: StoredProviderInstallation,
): Effect.Effect<boolean, ProviderPersistenceFailure> =>
  Effect.gen(function* storedInstanceSchemaValidation() {
    const instanceIds = yield* persistence.listInstallationInstanceIds(installation.providerTypeId);
    for (const instanceId of instanceIds) {
      const instance = yield* persistence.loadInstance(instanceId);
      const completeConfiguration = {
        ...instance.configuration,
        ...instance.credentials,
      };
      if (
        !configurationMatchesRestrictedSchema(
          installation.configurationSchema,
          completeConfiguration,
        )
      ) {
        return false;
      }
    }
    return true;
  }).pipe(Effect.catchTag("ProviderCredentialsUnavailable", () => Effect.succeed(false)));

const reconcileProvider = (
  persistence: ProviderPersistence,
  supervisor: PluginSupervisorService,
  provider: (typeof bundledProviders)[number],
): Effect.Effect<ProviderDiscoveryStatus, ProviderPersistenceFailure> =>
  Effect.matchEffect(discoverProvider(supervisor, provider), {
    onFailure: (failure) => {
      if (
        "reason" in failure &&
        (failure.reason === "descriptor_invalid" || failure.reason === "executable_invalid")
      ) {
        return Effect.die(new Error("invalid bundled provider descriptor"));
      }
      if (
        "reason" in failure &&
        (failure.reason === "contract_unsupported" || failure.reason === "provider_type_mismatch")
      ) {
        return Effect.succeed("incompatible" as const);
      }
      return Effect.succeed("unavailable" as const);
    },
    onSuccess: (pluginInfo) => {
      if (pluginInfo === undefined) {
        return Effect.succeed("incompatible" as const);
      }
      const installation = normalizeDiscoveredPluginInfo(pluginInfo, provider.providerTypeId);
      if (installation === undefined) {
        return Effect.succeed("incompatible" as const);
      }
      return persistence.loadInstallation(provider.providerTypeId).pipe(
        Effect.flatMap((previous) => {
          if (
            previous !== undefined &&
            !isInstallationSchemaCompatible(
              previous,
              installation,
              provider.migratedRequiredProperties,
            )
          ) {
            return Effect.succeed("incompatible" as const);
          }
          return storedInstancesMatchSchema(persistence, installation).pipe(
            Effect.flatMap((compatible) => {
              if (!compatible) {
                return Effect.succeed("incompatible" as const);
              }
              return persistence
                .acceptInstallation(installation)
                .pipe(Effect.as("available" as const));
            }),
          );
        }),
      );
    },
  });

const normalizedPageSize = (pageSize: number): number => {
  if (pageSize === ZERO) {
    return DEFAULT_PAGE_SIZE;
  }
  if (Number.isSafeInteger(pageSize) && pageSize > ZERO && pageSize <= MAXIMUM_PAGE_SIZE) {
    return pageSize;
  }
  return ZERO;
};

const providerTypeCursor = ({
  input,
  now,
  pageSize,
  pageTokens,
}: ProviderTypeCursorInput): Effect.Effect<string, PageTokenInvalidFailure> =>
  Effect.try({
    catch: pageTokenFailure,
    try: () => {
      if (input.pageToken.length === ZERO) {
        return "";
      }
      return pageTokens.decode({
        administratorId: input.administratorId,
        method: LIST_PROVIDER_TYPES_METHOD,
        now,
        pageSize,
        query: NORMALIZED_PROVIDER_TYPE_QUERY,
        token: input.pageToken,
      });
    },
  });

const installationReadInput = (cursor: string, pageSize: number): ProviderInstallationListInput => {
  if (cursor.length === ZERO) {
    return {
      limit: pageSize + NEXT_ROW,
      providerTypeIds: bundledProviderTypeIds,
    };
  }
  return {
    afterProviderTypeId: cursor,
    limit: pageSize + NEXT_ROW,
    providerTypeIds: bundledProviderTypeIds,
  };
};

const listProviderTypes = (
  persistence: ProviderPersistence,
  pageTokens: PageTokenCodec,
  input: ListProviderTypesInput,
): Effect.Effect<ListProviderTypesResult, PageTokenInvalidFailure | ProviderPersistenceFailure> =>
  Effect.gen(function* listProviderTypesEffect() {
    const pageSize = normalizedPageSize(input.pageSize);
    if (pageSize === ZERO || input.administratorId.length === ZERO) {
      return yield* Effect.fail(new PageTokenInvalid({}));
    }
    const now = yield* Clock.currentTimeMillis;
    const cursor = yield* providerTypeCursor({ input, now, pageSize, pageTokens });
    const installations = yield* persistence.listInstallations(
      installationReadInput(cursor, pageSize),
    );
    const hasNextPage = installations.length > pageSize;
    const providerTypes = installations.slice(ZERO, pageSize);
    if (!hasNextPage) {
      return { nextPageToken: "", providerTypes };
    }
    const nextCursor = providerTypes.at(LAST_ITEM)?.providerTypeId;
    if (nextCursor === undefined) {
      return yield* Effect.fail(new PageTokenInvalid({}));
    }
    const nextPageToken = yield* Effect.try({
      catch: pageTokenFailure,
      try: () =>
        pageTokens.encode({
          administratorId: input.administratorId,
          cursor: nextCursor,
          expiresAt: now + PAGE_TOKEN_LIFETIME_MILLISECONDS,
          method: LIST_PROVIDER_TYPES_METHOD,
          pageSize,
          query: NORMALIZED_PROVIDER_TYPE_QUERY,
        }),
    });
    return { nextPageToken, providerTypes };
  });

const makeProviderManagement = ({
  masterKey,
  persistence,
  supervisor,
}: ProviderManagementDependencies): Effect.Effect<
  ProviderManagementService,
  PageTokenInvalidFailure | ProviderPersistenceFailure,
  Scope.Scope
> =>
  Effect.gen(function* makeProviderManagementService() {
    validateBundledProviderRegistry();
    const pageTokens = yield* Effect.acquireRelease(
      Effect.tryPromise({
        catch: pageTokenFailure,
        try: () => makePageTokenCodec(masterKey),
      }),
      (codec) => Effect.sync(codec.close),
    );
    for (const provider of bundledProviders) {
      const status = yield* reconcileProvider(persistence, supervisor, provider);
      yield* Effect.logInfo({
        event: "provider.discovery_completed",
        providerType: provider.providerTypeId,
        status,
      });
    }
    return Object.freeze({
      listProviderTypes: (input: ListProviderTypesInput) =>
        listProviderTypes(persistence, pageTokens, input),
    });
  });

const contextService = Context.Service;

class ProviderManagement extends contextService<ProviderManagement, ProviderManagementService>()(
  "@nama/server/ProviderManagement",
) {
  static readonly layer = Layer.effect(
    ProviderManagement,
    Effect.gen(function* makeProviderManagementService() {
      const config = yield* Config;
      const database = yield* Database;
      const supervisor = yield* PluginSupervisor;
      const service = yield* makeProviderManagement({
        masterKey: Redacted.value(config.security.masterKey),
        persistence: database.providers,
        supervisor,
      });
      return ProviderManagement.of(service);
    }),
  );
}

export { ProviderManagement, makeProviderManagement };
export type {
  ListProviderTypesInput,
  ListProviderTypesResult,
  ProviderManagementDependencies,
  ProviderManagementService,
};
