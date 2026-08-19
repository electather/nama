// oxlint-disable eslint/max-lines -- Provider persistence keeps protection, transactions, and fail-closed state behind one database-owned seam.
import { and, eq, gt, max, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data, Effect, Redacted } from "effect";

import type { ConfigService } from "../config/schema.ts";
import {
  authenticateCredential,
  credentialUnavailableSignal,
  decryptCredential,
  deriveProtectionKeys,
  destroyProtectionKeys,
  digestPrincipal,
  encryptCredential,
  fingerprintOperation,
  isUnreadableCredential,
  principalDigestsMatch,
} from "./provider-protection-private.ts";
import type {
  CredentialEnvelope,
  ProtectionKeys,
  StoredCredentialEnvelope,
} from "./provider-protection-private.ts";
import {
  providerCredential,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerOperationResult,
} from "./provider-schema.ts";
import type { JsonObject, JsonValue } from "./provider-schema.ts";
import type { databaseSchema } from "./schema.ts";

const FIRST_INDEX = 0;
const NO_ROWS = 0;
const MAX_CREDENTIALS_PER_INSTANCE = 100;
const MAX_PROVIDER_INSTANCES = 100;
const PROVIDER_CREDENTIAL_OVERFLOW_LIMIT = 101;
const PROVIDER_INSTANCE_OVERFLOW_LIMIT = 101;
const OPERATION_CLEANUP_BATCH_SIZE = 100;
const PRIORITY_INCREMENT = 1;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

type ProviderDatabase = NodePgDatabase<typeof databaseSchema>;
type ProviderMutationMethod =
  | "nama.api.v1.ProviderService.CreateProviderInstance"
  | "nama.api.v1.ProviderService.DeleteProviderInstance"
  | "nama.api.v1.ProviderService.UpdateProviderInstance";
type ProviderObservationStatus = "authentication_failed" | "healthy" | "unavailable";

interface ProviderInstallationInput {
  readonly capabilities: readonly number[];
  readonly configurationSchema: JsonObject;
  readonly contractMajor: number;
  readonly description: string;
  readonly displayName: string;
  readonly pluginBuildVersion: string;
  readonly providerTypeId: string;
  readonly schemaProfileVersion: number;
  readonly schemaRevision: string;
}

interface ProviderOperationInput {
  readonly administratorUserId: string;
  readonly canonicalRequest: Uint8Array;
  readonly method: ProviderMutationMethod;
  readonly operationId: string;
  readonly serializedResult: JsonObject;
}

interface ProviderInstanceInput {
  readonly configuration: JsonObject;
  readonly credentials: Readonly<Record<string, string>>;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly observation: Readonly<{
    readonly status: ProviderObservationStatus;
    readonly summary: string;
  }>;
  readonly operation: ProviderOperationInput;
  readonly principalReference: string;
  readonly providerTypeId: string;
  readonly revision: string;
  readonly syncPriority?: number;
}

interface ProviderInstanceDeletionInput {
  readonly operation: ProviderOperationInput;
  readonly providerInstanceId: string;
}

interface ProviderObservationInput {
  readonly providerInstanceId: string;
  readonly revision: string;
  readonly status: ProviderObservationStatus;
  readonly summary: string;
}

interface ProviderOperationLookup {
  readonly administratorUserId: string;
  readonly canonicalRequest: Uint8Array;
  readonly method: ProviderMutationMethod;
  readonly operationId: string;
}

interface StoredProviderInstance {
  readonly configuration: JsonObject;
  readonly credentials: Readonly<Record<string, string>>;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly providerTypeId: string;
  readonly revision: string;
  readonly syncPriority: number;
}

const taggedError = Data.TaggedError;
const ProviderPersistenceError = taggedError("ProviderPersistenceError")<Record<string, never>>;
const ProviderCredentialsUnavailable = taggedError("ProviderCredentialsUnavailable")<
  Record<string, never>
>;
const ProviderOperationKeyReused = taggedError("ProviderOperationKeyReused")<Record<string, never>>;
type ProviderPersistenceFailure = InstanceType<typeof ProviderPersistenceError>;
type ProviderCredentialsFailure = InstanceType<typeof ProviderCredentialsUnavailable>;
type ProviderOperationKeyReuse = InstanceType<typeof ProviderOperationKeyReused>;

interface ProviderPersistence {
  readonly acceptInstallation: (
    input: ProviderInstallationInput,
  ) => Effect.Effect<void, ProviderPersistenceFailure>;
  readonly createInstance: (
    input: ProviderInstanceInput,
  ) => Effect.Effect<void, ProviderPersistenceFailure>;
  readonly deleteInstance: (
    input: ProviderInstanceDeletionInput,
  ) => Effect.Effect<boolean, ProviderPersistenceFailure>;
  readonly loadInstance: (
    providerInstanceId: string,
  ) => Effect.Effect<
    StoredProviderInstance,
    ProviderCredentialsFailure | ProviderPersistenceFailure
  >;
  readonly matchesPrincipal: (
    providerInstanceId: string,
    principalReference: string,
  ) => Effect.Effect<boolean, ProviderCredentialsFailure | ProviderPersistenceFailure>;
  readonly readOperationResult: (
    lookup: ProviderOperationLookup,
  ) => Effect.Effect<
    JsonObject | undefined,
    ProviderOperationKeyReuse | ProviderPersistenceFailure
  >;
  readonly recordObservation: (
    input: ProviderObservationInput,
  ) => Effect.Effect<boolean, ProviderPersistenceFailure>;
}

interface ProviderPersistenceContext {
  readonly database: ProviderDatabase;
  readonly keys: ProtectionKeys;
  readonly unavailableInstances: Set<string>;
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

const persistenceFailure = (): ProviderPersistenceFailure => new ProviderPersistenceError({});

const credentialFailure = (
  error: unknown,
): ProviderCredentialsFailure | ProviderPersistenceFailure => {
  if (isUnreadableCredential(error)) {
    return new ProviderCredentialsUnavailable({});
  }
  return persistenceFailure();
};

const operationLookupFailure = (
  error: unknown,
): ProviderOperationKeyReuse | ProviderPersistenceFailure => {
  if (error instanceof ProviderOperationKeyReused) {
    return error;
  }
  return persistenceFailure();
};

const cleanupExpiredOperationResults = async (database: ProviderDatabase): Promise<void> => {
  await database.execute(sql`
    with expired_provider_operations as (
      select administrator_user_id, method, operation_id
      from ${providerOperationResult}
      where expires_at <= transaction_timestamp()
      order by expires_at, completed_at
      limit ${OPERATION_CLEANUP_BATCH_SIZE}
      for update skip locked
    )
    delete from ${providerOperationResult} as result
    using expired_provider_operations as expired
    where result.administrator_user_id = expired.administrator_user_id
      and result.method = expired.method
      and result.operation_id = expired.operation_id
  `);
};

const storedEnvelopes = (
  database: ProviderDatabase,
  providerInstanceId: string,
): Promise<readonly StoredCredentialEnvelope[]> =>
  database
    .select({
      authenticationTag: providerCredential.authenticationTag,
      ciphertext: providerCredential.ciphertext,
      configurationKey: providerCredential.configurationKey,
      envelopeVersion: providerCredential.envelopeVersion,
      nonce: providerCredential.nonce,
      providerInstanceId: providerCredential.providerInstanceId,
      providerTypeId: providerInstance.providerTypeId,
    })
    .from(providerCredential)
    .innerJoin(providerInstance, eq(providerCredential.providerInstanceId, providerInstance.id))
    .where(eq(providerCredential.providerInstanceId, providerInstanceId))
    .limit(PROVIDER_CREDENTIAL_OVERFLOW_LIMIT);

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requiredCredentialKeys = (configurationSchema: JsonObject): readonly string[] => {
  const { properties, required } = configurationSchema;
  if (!isJsonObject(properties) || !Array.isArray(required)) {
    return [];
  }
  return required.flatMap((value) => {
    if (typeof value !== "string") {
      throw credentialUnavailableSignal;
    }
    const property = properties[value];
    if (isJsonObject(property) && property["writeOnly"] === true) {
      return [value];
    }
    return [];
  });
};

const assertCredentialCompleteness = (
  configurationSchema: JsonObject,
  configurationKeys: readonly string[],
): void => {
  if (configurationKeys.length > MAX_CREDENTIALS_PER_INSTANCE) {
    throw credentialUnavailableSignal;
  }
  const available = new Set(configurationKeys);
  for (const requiredKey of requiredCredentialKeys(configurationSchema)) {
    if (!available.has(requiredKey)) {
      throw credentialUnavailableSignal;
    }
  }
};

interface StoredProtectionInstance {
  readonly configurationSchema: JsonObject;
  readonly id: string;
}

const storedProtectionInstances = async (
  database: ProviderDatabase,
): Promise<readonly StoredProtectionInstance[]> => {
  const instances = await database
    .select({
      configurationSchema: providerInstallation.configurationSchema,
      id: providerInstance.id,
    })
    .from(providerInstance)
    .innerJoin(
      providerInstallation,
      eq(providerInstance.providerTypeId, providerInstallation.providerTypeId),
    )
    .limit(PROVIDER_INSTANCE_OVERFLOW_LIMIT);
  if (instances.length > MAX_PROVIDER_INSTANCES) {
    throw new Error("Provider instance limit invariant violated");
  }
  return instances;
};

const authenticateStoredInstance = async (
  database: ProviderDatabase,
  keys: ProtectionKeys,
  instance: StoredProtectionInstance,
): Promise<boolean> => {
  try {
    const envelopes = await storedEnvelopes(database, instance.id);
    assertCredentialCompleteness(
      instance.configurationSchema,
      envelopes.map(({ configurationKey }) => configurationKey),
    );
    for (const envelope of envelopes) {
      authenticateCredential(keys.credential, envelope);
    }
    return true;
  } catch (error) {
    if (isUnreadableCredential(error)) {
      return false;
    }
    throw error;
  }
};

const authenticateStoredCredentials = async (
  database: ProviderDatabase,
  keys: ProtectionKeys,
): Promise<Set<string>> => {
  const unavailableInstances = new Set<string>();
  const instances = await storedProtectionInstances(database);
  for (const instance of instances) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Authenticate one instance at a time to bound recovered secret material.
    if (!(await authenticateStoredInstance(database, keys, instance))) {
      unavailableInstances.add(instance.id);
    }
  }
  return unavailableInstances;
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

const installationConfigurationSchema = async (
  database: ProviderDatabase,
  providerTypeId: string,
): Promise<JsonObject> => {
  const rows = await database
    .select({ configurationSchema: providerInstallation.configurationSchema })
    .from(providerInstallation)
    .where(eq(providerInstallation.providerTypeId, providerTypeId))
    .limit(SINGLE_ROW_LIMIT);
  const installation = rows.at(FIRST_INDEX);
  if (installation === undefined) {
    throw new Error("Provider installation not found");
  }
  return installation.configurationSchema;
};

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

const requireCredentialsAvailable = (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
): void => {
  if (context.unavailableInstances.has(providerInstanceId)) {
    throw credentialUnavailableSignal;
  }
};

const selectStoredInstance = async (database: ProviderDatabase, providerInstanceId: string) => {
  const instances = await database
    .select({
      configuration: providerInstance.configuration,
      configurationSchema: providerInstallation.configurationSchema,
      displayName: providerInstance.displayName,
      enabled: providerInstance.enabled,
      id: providerInstance.id,
      principalDigest: providerInstance.principalDigest,
      providerTypeId: providerInstance.providerTypeId,
      revision: providerInstance.revision,
      syncPriority: providerInstance.syncPriority,
    })
    .from(providerInstance)
    .innerJoin(
      providerInstallation,
      eq(providerInstance.providerTypeId, providerInstallation.providerTypeId),
    )
    .where(eq(providerInstance.id, providerInstanceId))
    .limit(SINGLE_ROW_LIMIT);
  const instance = instances.at(FIRST_INDEX);
  if (instance === undefined) {
    throw new Error("Provider instance not found");
  }
  return instance;
};

const decryptStoredCredentials = async (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
  configurationSchema: JsonObject,
): Promise<Readonly<Record<string, string>>> => {
  const envelopes = await storedEnvelopes(context.database, providerInstanceId);
  assertCredentialCompleteness(
    configurationSchema,
    envelopes.map(({ configurationKey }) => configurationKey),
  );
  const credentials: Record<string, string> = {};
  for (const envelope of envelopes) {
    credentials[envelope.configurationKey] = decryptCredential(context.keys.credential, envelope);
  }
  return Object.freeze(credentials);
};

const recoverCredentials = async (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
  configurationSchema: JsonObject,
): Promise<Readonly<Record<string, string>>> => {
  try {
    const credentials = await decryptStoredCredentials(
      context,
      providerInstanceId,
      configurationSchema,
    );
    context.unavailableInstances.delete(providerInstanceId);
    return credentials;
  } catch (error) {
    if (isUnreadableCredential(error)) {
      context.unavailableInstances.add(providerInstanceId);
    }
    throw error;
  }
};

const loadInstance = (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
): Effect.Effect<StoredProviderInstance, ProviderCredentialsFailure | ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: credentialFailure,
    try: async () => {
      requireCredentialsAvailable(context, providerInstanceId);
      const instance = await selectStoredInstance(context.database, providerInstanceId);
      const credentials = await recoverCredentials(
        context,
        providerInstanceId,
        instance.configurationSchema,
      );
      return Object.freeze({
        configuration: instance.configuration,
        credentials,
        displayName: instance.displayName,
        enabled: instance.enabled,
        id: instance.id,
        providerTypeId: instance.providerTypeId,
        revision: instance.revision,
        syncPriority: instance.syncPriority,
      });
    },
  });

const matchesPrincipal = (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
  principalReference: string,
): Effect.Effect<boolean, ProviderCredentialsFailure | ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: credentialFailure,
    try: async () => {
      requireCredentialsAvailable(context, providerInstanceId);
      const instance = await selectStoredInstance(context.database, providerInstanceId);
      const candidate = digestPrincipal(
        context.keys.principal,
        { providerInstanceId, providerTypeId: instance.providerTypeId },
        principalReference,
      );
      try {
        return principalDigestsMatch(candidate, instance.principalDigest);
      } finally {
        candidate.fill(ZERO);
      }
    },
  });

interface StoredOperationResult {
  readonly requestFingerprint: Buffer;
  readonly serializedResult: JsonObject;
}

const verifyOperationResult = (
  key: Buffer,
  lookup: ProviderOperationLookup,
  row: StoredOperationResult,
): JsonObject => {
  const expectedFingerprint = fingerprintOperation(key, lookup);
  try {
    if (!principalDigestsMatch(expectedFingerprint, row.requestFingerprint)) {
      throw new ProviderOperationKeyReused({});
    }
    return row.serializedResult;
  } finally {
    expectedFingerprint.fill(ZERO);
  }
};

const readOperationResult = (
  context: ProviderPersistenceContext,
  lookup: ProviderOperationLookup,
): Effect.Effect<JsonObject | undefined, ProviderOperationKeyReuse | ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: operationLookupFailure,
    try: async () => {
      const scope = [
        eq(providerOperationResult.administratorUserId, lookup.administratorUserId),
        eq(providerOperationResult.method, lookup.method),
        eq(providerOperationResult.operationId, lookup.operationId),
        gt(providerOperationResult.expiresAt, sql`transaction_timestamp()`),
      ] as const;
      const rows = await context.database
        .select({
          requestFingerprint: providerOperationResult.requestFingerprint,
          serializedResult: providerOperationResult.serializedResult,
        })
        .from(providerOperationResult)
        .where(and(...scope))
        .limit(SINGLE_ROW_LIMIT);
      const row = rows.at(FIRST_INDEX);
      if (row === undefined) {
        return rows[FIRST_INDEX]?.serializedResult;
      }
      return verifyOperationResult(context.keys.operation, lookup, row);
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

const acquirePersistenceContext = async (
  database: ProviderDatabase,
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
        loadInstance: (providerInstanceId) => loadInstance(context, providerInstanceId),
        matchesPrincipal: (providerInstanceId, principalReference) =>
          matchesPrincipal(context, providerInstanceId, principalReference),
        readOperationResult: (lookup) => readOperationResult(context, lookup),
        recordObservation: (input) => recordObservation(context, input),
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
  type JsonObject,
  type ProviderCredentialsFailure,
  type ProviderInstanceDeletionInput,
  type ProviderInstanceInput,
  type ProviderInstallationInput,
  type ProviderMutationMethod,
  type ProviderObservationInput,
  type ProviderObservationStatus,
  type ProviderOperationInput,
  type ProviderOperationKeyReuse,
  type ProviderOperationLookup,
  type ProviderPersistence,
  type ProviderPersistenceFailure,
  type StoredProviderInstance,
  makeProviderPersistence,
};
