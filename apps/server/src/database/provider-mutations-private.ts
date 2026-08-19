import { and, eq, max, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  assertCredentialCompleteness,
  installationConfigurationSchema,
} from "./provider-credentials-private.ts";
import { cleanupExpiredOperationResults } from "./provider-operation-results-private.ts";
import { persistenceFailure } from "./provider-persistence-model-private.ts";
import type {
  ProviderDatabase,
  ProviderInstanceDeletionInput,
  ProviderInstanceInput,
  ProviderInstallationInput,
  ProviderObservationInput,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
} from "./provider-persistence-model-private.ts";
import {
  digestPrincipal,
  encryptCredential,
  fingerprintOperation,
} from "./provider-protection-private.ts";
import type { CredentialEnvelope, ProtectionKeys } from "./provider-protection-private.ts";
import {
  providerCredential,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerOperationResult,
} from "./provider-schema.ts";

const FIRST_INDEX = 0;
const NO_ROWS = 0;
const PRIORITY_INCREMENT = 1;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

interface ProtectedCredentialRow extends CredentialEnvelope {
  readonly configurationKey: string;
  readonly providerInstanceId: string;
}

interface ProtectedInstanceMaterial {
  readonly credentials: ProtectedCredentialRow[];
  readonly principalDigest: Buffer;
  readonly requestFingerprint: Buffer;
}

const acceptInstallation = (
  context: ProviderPersistenceContext,
  input: ProviderInstallationInput,
): Effect.Effect<void, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      await context.database
        .insert(providerInstallation)
        .values(input)
        .onConflictDoUpdate({
          set: {
            capabilities: input.capabilities,
            configurationSchema: input.configurationSchema,
            contractMajor: input.contractMajor,
            description: input.description,
            displayName: input.displayName,
            pluginBuildVersion: input.pluginBuildVersion,
            schemaProfileVersion: input.schemaProfileVersion,
            schemaRevision: input.schemaRevision,
            updatedAt: sql`transaction_timestamp()`,
          },
          target: providerInstallation.providerTypeId,
        });
    },
  });

const protectInstanceMaterial = (
  keys: ProtectionKeys,
  input: ProviderInstanceInput,
): ProtectedInstanceMaterial => {
  const credentials: ProtectedCredentialRow[] = [];
  for (const [configurationKey, value] of Object.entries(input.credentials)) {
    const envelope = encryptCredential(
      keys.credential,
      {
        configurationKey,
        providerInstanceId: input.id,
        providerTypeId: input.providerTypeId,
      },
      value,
    );
    credentials.push(Object.assign(envelope, { configurationKey, providerInstanceId: input.id }));
  }
  const principalDigest = digestPrincipal(
    keys.principal,
    { providerInstanceId: input.id, providerTypeId: input.providerTypeId },
    input.principalReference,
  );
  const requestFingerprint = fingerprintOperation(keys.operation, input.operation);
  return { credentials, principalDigest, requestFingerprint };
};

const destroyInstanceMaterial = (material: ProtectedInstanceMaterial): void => {
  material.principalDigest.fill(ZERO);
  material.requestFingerprint.fill(ZERO);
  for (const envelope of material.credentials) {
    envelope.authenticationTag.fill(ZERO);
    envelope.ciphertext.fill(ZERO);
    envelope.nonce.fill(ZERO);
  }
};

const persistNewInstance = async (
  database: ProviderDatabase,
  input: ProviderInstanceInput,
  material: ProtectedInstanceMaterial,
): Promise<void> => {
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select "key" from nama_server_state where "key" = 'server' for update`,
    );
    const priorities = await transaction
      .select({ maximum: max(providerInstance.syncPriority) })
      .from(providerInstance);
    const maximumPriority = priorities.at(FIRST_INDEX)?.maximum ?? NO_ROWS;
    const syncPriority = input.syncPriority ?? maximumPriority + PRIORITY_INCREMENT;
    await transaction.insert(providerInstance).values({
      configuration: input.configuration,
      displayName: input.displayName,
      enabled: input.enabled,
      id: input.id,
      principalDigest: material.principalDigest,
      providerTypeId: input.providerTypeId,
      revision: input.revision,
      syncPriority,
    });
    if (material.credentials.length > NO_ROWS) {
      await transaction.insert(providerCredential).values(material.credentials);
    }
    await transaction.insert(providerInstanceObservation).values({
      instanceRevision: input.revision,
      providerInstanceId: input.id,
      status: input.observation.status,
      summary: input.observation.summary,
    });
    await transaction.insert(providerOperationResult).values({
      administratorUserId: input.operation.administratorUserId,
      method: input.operation.method,
      operationId: input.operation.operationId,
      requestFingerprint: material.requestFingerprint,
      serializedResult: input.operation.serializedResult,
    });
  });
};

const assertNonsecretConfiguration = (input: ProviderInstanceInput): void => {
  const secretInConfiguration = Object.keys(input.credentials).some((configurationKey) =>
    Object.hasOwn(input.configuration, configurationKey),
  );
  if (secretInConfiguration) {
    throw new Error("Provider secret supplied in non-secret configuration");
  }
};

const createInstance = (
  context: ProviderPersistenceContext,
  input: ProviderInstanceInput,
): Effect.Effect<void, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      await cleanupExpiredOperationResults(context.database);
      assertNonsecretConfiguration(input);
      const configurationSchema = await installationConfigurationSchema(
        context.database,
        input.providerTypeId,
      );
      assertCredentialCompleteness(configurationSchema, Object.keys(input.credentials));
      const material = protectInstanceMaterial(context.keys, input);
      try {
        await persistNewInstance(context.database, input, material);
        context.unavailableInstances.delete(input.id);
      } finally {
        destroyInstanceMaterial(material);
      }
    },
  });

const recordObservation = (
  context: ProviderPersistenceContext,
  input: ProviderObservationInput,
): Effect.Effect<boolean, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: () =>
      context.database.transaction(async (transaction) => {
        const current = await transaction
          .select({ id: providerInstance.id })
          .from(providerInstance)
          .where(
            and(
              eq(providerInstance.id, input.providerInstanceId),
              eq(providerInstance.revision, input.revision),
            ),
          )
          .for("update")
          .limit(SINGLE_ROW_LIMIT);
        if (current.length === NO_ROWS) {
          return false;
        }
        await transaction
          .insert(providerInstanceObservation)
          .values({
            instanceRevision: input.revision,
            providerInstanceId: input.providerInstanceId,
            status: input.status,
            summary: input.summary,
          })
          .onConflictDoUpdate({
            set: {
              instanceRevision: input.revision,
              observedAt: sql`transaction_timestamp()`,
              status: input.status,
              summary: input.summary,
            },
            target: providerInstanceObservation.providerInstanceId,
          });
        return true;
      }),
  });

const deleteInstance = (
  context: ProviderPersistenceContext,
  input: ProviderInstanceDeletionInput,
): Effect.Effect<boolean, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      await cleanupExpiredOperationResults(context.database);
      const requestFingerprint = fingerprintOperation(context.keys.operation, input.operation);
      try {
        const deleted = await context.database.transaction(async (transaction) => {
          const rows = await transaction
            .delete(providerInstance)
            .where(eq(providerInstance.id, input.providerInstanceId))
            .returning({ id: providerInstance.id });
          if (rows.length > NO_ROWS) {
            await transaction.insert(providerOperationResult).values({
              administratorUserId: input.operation.administratorUserId,
              method: input.operation.method,
              operationId: input.operation.operationId,
              requestFingerprint,
              serializedResult: input.operation.serializedResult,
            });
          }
          return rows.length > NO_ROWS;
        });
        if (deleted) {
          context.unavailableInstances.delete(input.providerInstanceId);
        }
        return deleted;
      } finally {
        requestFingerprint.fill(ZERO);
      }
    },
  });

export { acceptInstallation, createInstance, deleteInstance, recordObservation };
