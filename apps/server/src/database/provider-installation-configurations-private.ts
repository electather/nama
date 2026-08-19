import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { assertCredentialCompleteness } from "./provider-credentials-private.ts";
import { credentialFailure } from "./provider-persistence-model-private.ts";
import type {
  ProviderCredentialsFailure,
  ProviderDatabase,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
} from "./provider-persistence-model-private.ts";
import {
  credentialUnavailableSignal,
  decryptCredential,
  isUnreadableCredential,
} from "./provider-protection-private.ts";
import type { StoredCredentialEnvelope } from "./provider-protection-private.ts";
import { providerCredential, providerInstallation, providerInstance } from "./provider-schema.ts";
import type { JsonObject, JsonValue } from "./provider-schema.ts";

const MAX_CREDENTIALS_PER_INSTANCE = 100;
const MAX_PROVIDER_INSTANCES = 100;
const OVERFLOW_ROW_COUNT = 1;
const PROVIDER_INSTANCE_OVERFLOW_LIMIT = MAX_PROVIDER_INSTANCES + OVERFLOW_ROW_COUNT;
const INSTALLATION_CREDENTIAL_OVERFLOW_LIMIT =
  MAX_CREDENTIALS_PER_INSTANCE * MAX_PROVIDER_INSTANCES + OVERFLOW_ROW_COUNT;

interface InstallationInstanceConfiguration {
  readonly configuration: JsonObject;
  readonly configurationSchema: JsonObject;
  readonly id: string;
}

interface ConfigurationRecoveryInput {
  readonly context: ProviderPersistenceContext;
  readonly envelopes: readonly StoredCredentialEnvelope[];
  readonly instance: InstallationInstanceConfiguration;
}

const selectInstallationInstances = async (
  database: ProviderDatabase,
  providerTypeId: string,
): Promise<readonly InstallationInstanceConfiguration[]> => {
  const instances = await database
    .select({
      configuration: providerInstance.configuration,
      configurationSchema: providerInstallation.configurationSchema,
      id: providerInstance.id,
    })
    .from(providerInstance)
    .innerJoin(
      providerInstallation,
      eq(providerInstance.providerTypeId, providerInstallation.providerTypeId),
    )
    .where(eq(providerInstance.providerTypeId, providerTypeId))
    .limit(PROVIDER_INSTANCE_OVERFLOW_LIMIT);
  if (instances.length > MAX_PROVIDER_INSTANCES) {
    throw new Error("Provider instance limit invariant violated");
  }
  return instances;
};

const selectInstallationEnvelopes = async (
  database: ProviderDatabase,
  providerTypeId: string,
): Promise<readonly StoredCredentialEnvelope[]> => {
  const envelopes = await database
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
    .where(eq(providerInstance.providerTypeId, providerTypeId))
    .limit(INSTALLATION_CREDENTIAL_OVERFLOW_LIMIT);
  if (envelopes.length >= INSTALLATION_CREDENTIAL_OVERFLOW_LIMIT) {
    throw credentialUnavailableSignal;
  }
  return envelopes;
};

const groupEnvelopesByInstance = (
  envelopes: readonly StoredCredentialEnvelope[],
): ReadonlyMap<string, readonly StoredCredentialEnvelope[]> => {
  const grouped = new Map<string, StoredCredentialEnvelope[]>();
  for (const envelope of envelopes) {
    const instanceEnvelopes = grouped.get(envelope.providerInstanceId);
    if (instanceEnvelopes === undefined) {
      grouped.set(envelope.providerInstanceId, [envelope]);
    } else {
      instanceEnvelopes.push(envelope);
    }
  }
  return grouped;
};

const decryptInstallationConfiguration = (input: ConfigurationRecoveryInput): JsonObject => {
  assertCredentialCompleteness(
    input.instance.configurationSchema,
    input.envelopes.map(({ configurationKey }) => configurationKey),
  );
  const configuration: Record<string, JsonValue> = { ...input.instance.configuration };
  for (const envelope of input.envelopes) {
    configuration[envelope.configurationKey] = decryptCredential(
      input.context.keys.credential,
      envelope,
    );
  }
  return Object.freeze(configuration);
};

const recoverInstallationConfiguration = (input: ConfigurationRecoveryInput): JsonObject => {
  try {
    if (input.context.unavailableInstances.has(input.instance.id)) {
      throw credentialUnavailableSignal;
    }
    const configuration = decryptInstallationConfiguration(input);
    input.context.unavailableInstances.delete(input.instance.id);
    return configuration;
  } catch (error) {
    if (isUnreadableCredential(error)) {
      input.context.unavailableInstances.add(input.instance.id);
    }
    throw error;
  }
};

const loadInstallationConfigurations = (
  context: ProviderPersistenceContext,
  providerTypeId: string,
): Effect.Effect<readonly JsonObject[], ProviderCredentialsFailure | ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: credentialFailure,
    try: async () => {
      const instances = await selectInstallationInstances(context.database, providerTypeId);
      const envelopes = await selectInstallationEnvelopes(context.database, providerTypeId);
      const envelopesByInstance = groupEnvelopesByInstance(envelopes);
      return Object.freeze(
        instances.map((instance) =>
          recoverInstallationConfiguration({
            context,
            envelopes: envelopesByInstance.get(instance.id) ?? [],
            instance,
          }),
        ),
      );
    },
  });

export { loadInstallationConfigurations };
