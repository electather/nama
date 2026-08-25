// oxlint-disable import/max-dependencies -- This private composition boundary wires the cohesive provider persistence operations over one context.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Effect, Redacted } from "effect";

import type { ConfigService } from "../config/schema.ts";
import {
  authenticateStoredCredentials,
  loadInstance,
  matchesPrincipal,
} from "./provider-credentials-private.ts";
import {
  listInstallations,
  loadInstallation,
  loadInstallationConfigurations,
} from "./provider-installations-private.ts";
import { listInstances, loadInstanceRecord } from "./provider-instance-reads-private.ts";
import {
  acceptInstallation,
  createInstance,
  deleteInstance,
  recordObservation,
  updateInstance,
} from "./provider-mutations-private.ts";
import {
  cleanupExpiredOperationResults,
  readOperationResult,
} from "./provider-operation-results-private.ts";
import {
  ProviderCredentialsUnavailable,
  persistenceFailure,
} from "./provider-persistence-model-private.ts";
import type {
  ProviderCredentialsFailure,
  ProviderInstallationInput,
  ProviderInstallationListInput,
  ProviderInstanceInput,
  ProviderInstanceListInput,
  ProviderInstanceRecord,
  ProviderPersistence,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
  StoredProviderInstance,
  StoredProviderInstallation,
} from "./provider-persistence-model-private.ts";
import { deriveProtectionKeys, destroyProtectionKeys } from "./provider-protection-private.ts";
import type { databaseSchema } from "./schema.ts";

const acquirePersistenceContext = async (
  database: NodePgDatabase<typeof databaseSchema>,
  masterKey: ConfigService["security"]["masterKey"],
): Promise<ProviderPersistenceContext> => {
  const keys = await deriveProtectionKeys(Redacted.value(masterKey));
  try {
    await cleanupExpiredOperationResults(database);
    const unavailableInstances = await authenticateStoredCredentials(database, keys);
    return Object.freeze({ database, keys, unavailableInstances });
  } catch (error) {
    destroyProtectionKeys(keys);
    throw error;
  }
};

const makeProviderPersistence = (
  database: NodePgDatabase<typeof databaseSchema>,
  masterKey: ConfigService["security"]["masterKey"],
): Effect.Effect<
  Readonly<{ readonly close: () => void; readonly service: ProviderPersistence }>,
  ProviderPersistenceFailure
> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const context = await acquirePersistenceContext(database, masterKey);
      const { keys } = context;
      const service: ProviderPersistence = {
        acceptInstallation: (input) => acceptInstallation(context, input),
        createInstance: (input) => createInstance(context, input),
        deleteInstance: (input) => deleteInstance(context, input),
        listInstallations: (input) => listInstallations(context, input),
        listInstances: (input) => listInstances(context, input),
        loadInstallation: (providerTypeId) => loadInstallation(context, providerTypeId),
        loadInstallationConfigurations: (providerTypeId) =>
          loadInstallationConfigurations(context, providerTypeId),
        loadInstance: (providerInstanceId) => loadInstance(context, providerInstanceId),
        loadInstanceRecord: (providerInstanceId) => loadInstanceRecord(context, providerInstanceId),
        matchesPrincipal: (providerInstanceId, principalReference) =>
          matchesPrincipal(context, providerInstanceId, principalReference),
        readOperationResult: (lookup) => readOperationResult(context, lookup),
        recordObservation: (input) => recordObservation(context, input),
        updateInstance: (input) => updateInstance(context, input),
      };
      Object.freeze(service);
      return Object.freeze({
        close: () => {
          destroyProtectionKeys(keys);
        },
        service,
      });
    },
  });

export {
  type ProviderCredentialsFailure,
  type ProviderInstallationInput,
  type ProviderInstallationListInput,
  type ProviderInstanceListInput,
  type ProviderInstanceRecord,
  type ProviderInstanceInput,
  type ProviderPersistence,
  type ProviderPersistenceFailure,
  type StoredProviderInstance,
  type StoredProviderInstallation,
  ProviderCredentialsUnavailable,
  persistenceFailure,
  makeProviderPersistence,
};
