import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { credentialFailure } from "./provider-persistence-model-private.ts";
import type {
  ProviderCredentialsFailure,
  ProviderDatabase,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
  StoredProviderInstance,
} from "./provider-persistence-model-private.ts";
import {
  authenticateCredential,
  credentialUnavailableSignal,
  decryptCredential,
  digestPrincipal,
  isUnreadableCredential,
  principalDigestsMatch,
} from "./provider-protection-private.ts";
import type { ProtectionKeys, StoredCredentialEnvelope } from "./provider-protection-private.ts";
import { providerCredential, providerInstallation, providerInstance } from "./provider-schema.ts";
import type { JsonObject, JsonValue } from "./provider-schema.ts";

const FIRST_INDEX = 0;
const MAX_CREDENTIALS_PER_INSTANCE = 100;
const MAX_PROVIDER_INSTANCES = 100;
const PROVIDER_CREDENTIAL_OVERFLOW_LIMIT = 101;
const PROVIDER_INSTANCE_OVERFLOW_LIMIT = 101;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

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
  const instances = await storedProtectionInstances(database);
  return instances.reduce<Promise<Set<string>>>(async (priorInstances, instance) => {
    const unavailableInstances = await priorInstances;
    if (!(await authenticateStoredInstance(database, keys, instance))) {
      unavailableInstances.add(instance.id);
    }
    return unavailableInstances;
  }, Promise.resolve(new Set<string>()));
};

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

export {
  assertCredentialCompleteness,
  authenticateStoredCredentials,
  installationConfigurationSchema,
  loadInstance,
  matchesPrincipal,
};
