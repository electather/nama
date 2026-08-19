// oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements, eslint/prefer-destructuring -- Provider writes keep transaction ordering, protected-material lifetime, and rollback boundaries explicit.
import { and, eq, inArray, max, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  assertCredentialCompleteness,
  installationConfigurationSchema,
} from "./provider-credentials-private.ts";
import { cleanupExpiredOperationResults } from "./provider-operation-results-private.ts";
import {
  ProviderInstanceLimitReached,
  ProviderRevisionMismatch,
  ProviderSyncPriorityConflict,
  persistenceFailure,
} from "./provider-persistence-model-private.ts";
import type {
  ProviderDatabase,
  ProviderInstanceDeletionInput,
  ProviderInstanceInput,
  ProviderInstanceUpdateInput,
  ProviderInstanceRecord,
  ProviderInstanceLimitFailure,
  ProviderInstallationInput,
  ProviderObservationInput,
  ProviderPersistenceContext,
  ProviderRevisionMismatchFailure,
  ProviderSyncPriorityConflictFailure,
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
import type { JsonObject } from "./provider-schema.ts";

const FIRST_INDEX = 0;
const NO_ROWS = 0;
const PRIORITY_INCREMENT = 1;
const SINGLE_ROW_LIMIT = 1;
const MAXIMUM_FAILURE_CAUSE_DEPTH = 4;
const ZERO = 0;
class RevisionMismatchSignalError extends Error {
  override readonly name = "RevisionMismatchSignalError";
}

interface ProtectedCredentialRow extends CredentialEnvelope {
  readonly configurationKey: string;
  readonly providerInstanceId: string;
}

interface ProtectedInstanceMaterial {
  readonly credentials: ProtectedCredentialRow[];
  readonly principalDigest: Buffer;
  readonly requestFingerprint: Buffer;
}

interface ProtectedUpdateMaterial {
  readonly credentials: ProtectedCredentialRow[];
  readonly requestFingerprint: Buffer;
}

interface PersistUpdatedInstanceInput {
  readonly configurationSchema: JsonObject;
  readonly credentialsAvailable: boolean;
  readonly database: ProviderDatabase;
  readonly input: ProviderInstanceUpdateInput;
  readonly material: ProtectedUpdateMaterial;
}
// fallow-ignore-next-line code-duplication -- The database boundary unwraps only own data properties without importing HTTP failure machinery.
const dataPropertyValue = (value: object, property: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) {
    return undefined;
  }
  return descriptor.value;
};

const persistedInstanceSelection = Object.freeze({
  configuration: providerInstance.configuration,
  createdAt: providerInstance.createdAt,
  displayName: providerInstance.displayName,
  enabled: providerInstance.enabled,
  id: providerInstance.id,
  providerTypeId: providerInstance.providerTypeId,
  revision: providerInstance.revision,
  syncPriority: providerInstance.syncPriority,
  updatedAt: providerInstance.updatedAt,
});

type ProviderConstraintFailure =
  | ProviderInstanceLimitFailure
  | ProviderRevisionMismatchFailure
  | ProviderSyncPriorityConflictFailure;

const isRevisionMismatchFailure = (
  failure: ProviderConstraintFailure,
): failure is ProviderRevisionMismatchFailure => failure instanceof ProviderRevisionMismatch;

const isInstanceLimitFailure = (
  failure: ProviderConstraintFailure,
): failure is ProviderInstanceLimitFailure => failure instanceof ProviderInstanceLimitReached;

const constraintFailureAt = (current: unknown): ProviderConstraintFailure | undefined => {
  if (current instanceof RevisionMismatchSignalError) {
    return new ProviderRevisionMismatch({});
  }
  if (typeof current !== "object" || current === null) {
    return undefined;
  }
  const code = dataPropertyValue(current, "code");
  const constraint = dataPropertyValue(current, "constraint");
  const message = dataPropertyValue(current, "message");
  if (code === "23514" && message === "provider instance limit exceeded") {
    return new ProviderInstanceLimitReached({});
  }
  if (code === "23505" && constraint === "provider_instance_enabled_sync_priority_unique") {
    return new ProviderSyncPriorityConflict({});
  }
  return undefined;
};

const nextFailureCause = (current: unknown): unknown => {
  if (typeof current !== "object" || current === null) {
    return undefined;
  }
  const cause = dataPropertyValue(current, "cause");
  if (cause === current) {
    return undefined;
  }
  return cause;
};

const providerConstraintFailure = (error: unknown): ProviderConstraintFailure | undefined => {
  let current = error;
  for (let depth = ZERO; depth < MAXIMUM_FAILURE_CAUSE_DEPTH; depth += PRIORITY_INCREMENT) {
    const failure = constraintFailureAt(current);
    if (failure !== undefined) {
      return failure;
    }
    const cause = nextFailureCause(current);
    if (cause === undefined) {
      return undefined;
    }
    current = cause;
  }
  return undefined;
};

const createInstanceFailure = (
  error: unknown,
):
  | ProviderInstanceLimitFailure
  | ProviderPersistenceFailure
  | ProviderSyncPriorityConflictFailure => {
  const failure = providerConstraintFailure(error);
  if (failure === undefined || isRevisionMismatchFailure(failure)) {
    return persistenceFailure();
  }
  return failure;
};

const updateInstanceFailure = (
  error: unknown,
):
  | ProviderPersistenceFailure
  | ProviderRevisionMismatchFailure
  | ProviderSyncPriorityConflictFailure => {
  const failure = providerConstraintFailure(error);
  if (failure === undefined || isInstanceLimitFailure(failure)) {
    return persistenceFailure();
  }
  return failure;
};

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

const protectUpdateMaterial = (
  keys: ProtectionKeys,
  input: ProviderInstanceUpdateInput,
): ProtectedUpdateMaterial => {
  const credentials: ProtectedCredentialRow[] = [];
  for (const [configurationKey, value] of Object.entries(input.credentialChanges)) {
    const envelope = encryptCredential(
      keys.credential,
      {
        configurationKey,
        providerInstanceId: input.providerInstanceId,
        providerTypeId: input.providerTypeId,
      },
      value,
    );
    credentials.push(
      Object.assign(envelope, {
        configurationKey,
        providerInstanceId: input.providerInstanceId,
      }),
    );
  }
  return {
    credentials,
    requestFingerprint: fingerprintOperation(keys.operation, input.operation),
  };
};

const destroyUpdateMaterial = (material: ProtectedUpdateMaterial): void => {
  material.requestFingerprint.fill(ZERO);
  for (const envelope of material.credentials) {
    envelope.authenticationTag.fill(ZERO);
    envelope.ciphertext.fill(ZERO);
    envelope.nonce.fill(ZERO);
  }
};

const persistNewInstance = (
  database: ProviderDatabase,
  input: ProviderInstanceInput,
  material: ProtectedInstanceMaterial,
): Promise<ProviderInstanceRecord> =>
  database.transaction(async (transaction) => {
    await transaction.execute(
      sql`select "key" from nama_server_state where "key" = 'server' for update`,
    );
    const priorities = await transaction
      .select({ maximum: max(providerInstance.syncPriority) })
      .from(providerInstance);
    const maximumPriority = priorities.at(FIRST_INDEX)?.maximum ?? NO_ROWS;
    const syncPriority = input.syncPriority ?? maximumPriority + PRIORITY_INCREMENT;
    const rows = await transaction
      .insert(providerInstance)
      .values({
        configuration: input.configuration,
        displayName: input.displayName,
        enabled: input.enabled,
        id: input.id,
        principalDigest: material.principalDigest,
        providerTypeId: input.providerTypeId,
        revision: input.revision,
        syncPriority,
      })
      .returning(persistedInstanceSelection);
    const stored = rows.at(FIRST_INDEX);
    if (stored === undefined) {
      throw new Error("provider instance insert returned no row");
    }
    if (material.credentials.length > NO_ROWS) {
      await transaction.insert(providerCredential).values(material.credentials);
    }
    await transaction.insert(providerInstanceObservation).values({
      instanceRevision: input.revision,
      providerInstanceId: input.id,
      status: input.observation.status,
      summary: input.observation.summary,
    });
    const result: ProviderInstanceRecord = {
      configuration: stored.configuration,
      configuredSecretKeys: Object.keys(input.credentials).toSorted(),
      createdAt: stored.createdAt,
      credentialsAvailable: true,
      displayName: stored.displayName,
      enabled: stored.enabled,
      id: stored.id,
      observation: input.observation,
      providerTypeId: stored.providerTypeId,
      revision: stored.revision,
      syncPriority: stored.syncPriority,
      updatedAt: stored.updatedAt,
    };
    const serializedResult =
      input.operation.serializeResult?.(result) ?? input.operation.serializedResult;
    if (serializedResult === undefined) {
      throw new Error("provider operation result is missing");
    }
    await transaction.insert(providerOperationResult).values({
      administratorUserId: input.operation.administratorUserId,
      method: input.operation.method,
      operationId: input.operation.operationId,
      requestFingerprint: material.requestFingerprint,
      serializedResult,
    });
    return result;
  });

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
): Effect.Effect<
  ProviderInstanceRecord,
  ProviderInstanceLimitFailure | ProviderPersistenceFailure | ProviderSyncPriorityConflictFailure
> =>
  Effect.tryPromise({
    catch: createInstanceFailure,
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
        const result = await persistNewInstance(context.database, input, material);
        context.unavailableInstances.delete(input.id);
        return result;
      } finally {
        destroyInstanceMaterial(material);
      }
    },
  });

type ProviderTransaction = Parameters<
  Parameters<ProviderDatabase["transaction"]>[typeof FIRST_INDEX]
>[typeof FIRST_INDEX];
type PersistedInstanceRow = Readonly<{
  configuration: JsonObject;
  createdAt: Date;
  displayName: string;
  enabled: boolean;
  id: string;
  providerTypeId: string;
  revision: string;
  syncPriority: number;
  updatedAt: Date;
}>;
type PersistUpdatedTransactionInput = Omit<PersistUpdatedInstanceInput, "database"> &
  Readonly<{ transaction: ProviderTransaction }>;

const updateProviderInstanceRow = async ({
  input,
  transaction,
}: PersistUpdatedTransactionInput): Promise<PersistedInstanceRow> => {
  const configurationUpdate: { configuration?: JsonObject } = {};
  if (input.configuration !== undefined) {
    configurationUpdate.configuration = input.configuration;
  }
  const rows = await transaction
    .update(providerInstance)
    .set({
      ...configurationUpdate,
      displayName: input.displayName,
      enabled: input.enabled,
      revision: input.revision,
      syncPriority: input.syncPriority,
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(providerInstance.id, input.providerInstanceId),
        eq(providerInstance.revision, input.expectedRevision),
      ),
    )
    .returning(persistedInstanceSelection);
  const stored = rows.at(FIRST_INDEX);
  if (stored === undefined) {
    throw new RevisionMismatchSignalError();
  }
  return stored;
};

const replaceUpdatedCredentials = async ({
  configurationSchema,
  input,
  material,
  transaction,
}: PersistUpdatedTransactionInput): Promise<readonly string[]> => {
  const changedCredentialKeys = [
    ...new Set([
      ...input.clearCredentialKeys,
      ...material.credentials.map(({ configurationKey }) => configurationKey),
    ]),
  ];
  if (changedCredentialKeys.length > NO_ROWS) {
    await transaction
      .delete(providerCredential)
      .where(
        and(
          eq(providerCredential.providerInstanceId, input.providerInstanceId),
          inArray(providerCredential.configurationKey, changedCredentialKeys),
        ),
      );
  }
  if (material.credentials.length > NO_ROWS) {
    await transaction.insert(providerCredential).values(material.credentials);
  }
  const configuredCredentialRows = await transaction
    .select({ configurationKey: providerCredential.configurationKey })
    .from(providerCredential)
    .where(eq(providerCredential.providerInstanceId, input.providerInstanceId))
    .orderBy(providerCredential.configurationKey);
  const configuredSecretKeys = configuredCredentialRows.map(
    ({ configurationKey }) => configurationKey,
  );
  assertCredentialCompleteness(configurationSchema, configuredSecretKeys);
  if (
    input.configuration !== undefined &&
    configuredSecretKeys.some((key) => Object.hasOwn(input.configuration ?? {}, key))
  ) {
    throw new Error("Provider secret supplied in non-secret configuration");
  }
  return configuredSecretKeys;
};

const loadUpdatedObservation = async ({
  input,
  transaction,
}: PersistUpdatedTransactionInput): Promise<ProviderInstanceRecord["observation"]> => {
  const observations = await transaction
    .select({
      status: providerInstanceObservation.status,
      summary: providerInstanceObservation.summary,
    })
    .from(providerInstanceObservation)
    .where(eq(providerInstanceObservation.providerInstanceId, input.providerInstanceId))
    .limit(SINGLE_ROW_LIMIT);
  const observation = observations.at(FIRST_INDEX);
  if (
    observation === undefined ||
    (observation.status !== "authentication_failed" &&
      observation.status !== "healthy" &&
      observation.status !== "unavailable")
  ) {
    throw new Error("provider instance observation is invalid");
  }
  return { status: observation.status, summary: observation.summary };
};

const persistUpdatedOperationResult = async (
  transactionInput: PersistUpdatedTransactionInput,
  result: ProviderInstanceRecord,
): Promise<void> => {
  const { input, material, transaction } = transactionInput;
  const serializedResult =
    input.operation.serializeResult?.(result) ?? input.operation.serializedResult;
  if (serializedResult === undefined) {
    throw new Error("provider update operation result is missing");
  }
  await transaction.insert(providerOperationResult).values({
    administratorUserId: input.operation.administratorUserId,
    method: input.operation.method,
    operationId: input.operation.operationId,
    requestFingerprint: material.requestFingerprint,
    serializedResult,
  });
};

const persistUpdatedInstance = ({
  configurationSchema,
  credentialsAvailable,
  database,
  input,
  material,
}: PersistUpdatedInstanceInput): Promise<ProviderInstanceRecord> =>
  database.transaction(async (transaction) => {
    const transactionInput: PersistUpdatedTransactionInput = {
      configurationSchema,
      credentialsAvailable,
      input,
      material,
      transaction,
    };
    const stored = await updateProviderInstanceRow(transactionInput);
    const configuredSecretKeys = await replaceUpdatedCredentials(transactionInput);
    const observation = await loadUpdatedObservation(transactionInput);
    const result: ProviderInstanceRecord = {
      configuration: stored.configuration,
      configuredSecretKeys,
      createdAt: stored.createdAt,
      credentialsAvailable,
      displayName: stored.displayName,
      enabled: stored.enabled,
      id: stored.id,
      observation,
      providerTypeId: stored.providerTypeId,
      revision: stored.revision,
      syncPriority: stored.syncPriority,
      updatedAt: stored.updatedAt,
    };
    await persistUpdatedOperationResult(transactionInput, result);
    return result;
  });

const updateInstance = (
  context: ProviderPersistenceContext,
  input: ProviderInstanceUpdateInput,
): Effect.Effect<
  ProviderInstanceRecord,
  ProviderPersistenceFailure | ProviderRevisionMismatchFailure | ProviderSyncPriorityConflictFailure
> =>
  Effect.tryPromise({
    catch: updateInstanceFailure,
    try: async () => {
      await cleanupExpiredOperationResults(context.database);
      const configurationSchema = await installationConfigurationSchema(
        context.database,
        input.providerTypeId,
      );
      const material = protectUpdateMaterial(context.keys, input);
      try {
        const result = await persistUpdatedInstance({
          configurationSchema,
          credentialsAvailable: !context.unavailableInstances.has(input.providerInstanceId),
          database: context.database,
          input,
          material,
        });
        if (
          input.configuration !== undefined ||
          Object.keys(input.credentialChanges).length > NO_ROWS
        ) {
          context.unavailableInstances.delete(input.providerInstanceId);
        }
        return result;
      } finally {
        destroyUpdateMaterial(material);
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
        const serializedResult = input.operation.serializedResult;
        if (serializedResult === undefined) {
          throw new Error("provider delete operation result is missing");
        }
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
              serializedResult,
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

export { acceptInstallation, createInstance, deleteInstance, recordObservation, updateInstance };
