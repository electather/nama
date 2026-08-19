import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { persistenceFailure } from "./provider-persistence-model-private.ts";
import type {
  ProviderInstallationListInput,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
  StoredProviderInstallation,
} from "./provider-persistence-model-private.ts";
import { providerInstallation, providerInstance } from "./provider-schema.ts";

const FIRST_ROW = 0;
const MAXIMUM_INSTALLATION_READ = 101;
const MAXIMUM_PROVIDER_INSTANCES = 100;
const SINGLE_ROW_LIMIT = 1;

const installationSelection = Object.freeze({
  capabilities: providerInstallation.capabilities,
  configurationSchema: providerInstallation.configurationSchema,
  contractMajor: providerInstallation.contractMajor,
  description: providerInstallation.description,
  displayName: providerInstallation.displayName,
  pluginBuildVersion: providerInstallation.pluginBuildVersion,
  providerTypeId: providerInstallation.providerTypeId,
  schemaProfileVersion: providerInstallation.schemaProfileVersion,
  schemaRevision: providerInstallation.schemaRevision,
});

const loadInstallation = (
  context: ProviderPersistenceContext,
  providerTypeId: string,
): Effect.Effect<StoredProviderInstallation | undefined, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const rows = await context.database
        .select(installationSelection)
        .from(providerInstallation)
        .where(eq(providerInstallation.providerTypeId, providerTypeId))
        .limit(SINGLE_ROW_LIMIT);
      return rows.at(FIRST_ROW);
    },
  });

const listInstallationInstanceIds = (
  context: ProviderPersistenceContext,
  providerTypeId: string,
): Effect.Effect<readonly string[], ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const rows = await context.database
        .select({ id: providerInstance.id })
        .from(providerInstance)
        .where(eq(providerInstance.providerTypeId, providerTypeId))
        .orderBy(asc(providerInstance.id))
        .limit(MAXIMUM_INSTALLATION_READ);
      if (rows.length > MAXIMUM_PROVIDER_INSTANCES) {
        throw new RangeError("provider instance limit exceeded");
      }
      return rows.map(({ id }) => id);
    },
  });

const validatedInstallationList = (input: ProviderInstallationListInput): readonly string[] => {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= FIRST_ROW ||
    input.limit > MAXIMUM_INSTALLATION_READ
  ) {
    throw new RangeError("invalid provider installation read limit");
  }
  if (input.providerTypeIds.length > MAXIMUM_INSTALLATION_READ) {
    throw new RangeError("invalid provider installation registry");
  }
  const uniqueProviderTypeIds = new Set<string>();
  for (const providerTypeId of input.providerTypeIds) {
    if (providerTypeId.length === FIRST_ROW || uniqueProviderTypeIds.has(providerTypeId)) {
      throw new RangeError("invalid provider installation registry");
    }
    uniqueProviderTypeIds.add(providerTypeId);
  }
  return [...input.providerTypeIds];
};

const listInstallations = (
  context: ProviderPersistenceContext,
  input: ProviderInstallationListInput,
): Effect.Effect<readonly StoredProviderInstallation[], ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const providerTypeIds = validatedInstallationList(input);
      if (providerTypeIds.length === FIRST_ROW) {
        return [];
      }
      const registryProviders = inArray(providerInstallation.providerTypeId, providerTypeIds);
      const query = context.database
        .select(installationSelection)
        .from(providerInstallation)
        .orderBy(asc(providerInstallation.providerTypeId))
        .limit(input.limit);
      if (input.afterProviderTypeId === undefined) {
        const rows = await query.where(registryProviders);
        return rows;
      }
      const rows = await query.where(
        and(registryProviders, gt(providerInstallation.providerTypeId, input.afterProviderTypeId)),
      );
      return rows;
    },
  });

export { listInstallationInstanceIds, listInstallations, loadInstallation };
