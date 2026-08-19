import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data } from "effect";
import type { Effect } from "effect";

import { isUnreadableCredential } from "./provider-protection-private.ts";
import type { ProtectionKeys } from "./provider-protection-private.ts";
import type { JsonObject } from "./provider-schema.ts";
import type { databaseSchema } from "./schema.ts";

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

interface ProviderInstallationListInput {
  readonly afterProviderTypeId?: string;
  readonly limit: number;
  readonly providerTypeIds: readonly string[];
}

type StoredProviderInstallation = ProviderInstallationInput;

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
  readonly listInstallations: (
    input: ProviderInstallationListInput,
  ) => Effect.Effect<readonly StoredProviderInstallation[], ProviderPersistenceFailure>;
  readonly loadInstallation: (
    providerTypeId: string,
  ) => Effect.Effect<StoredProviderInstallation | undefined, ProviderPersistenceFailure>;
  readonly loadInstallationConfigurations: (
    providerTypeId: string,
  ) => Effect.Effect<
    readonly JsonObject[],
    ProviderCredentialsFailure | ProviderPersistenceFailure
  >;
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

export {
  type ProviderCredentialsFailure,
  type ProviderDatabase,
  type ProviderInstanceDeletionInput,
  type ProviderInstanceInput,
  type ProviderInstallationListInput,
  type StoredProviderInstallation,
  type ProviderInstallationInput,
  type ProviderMutationMethod,
  type ProviderObservationInput,
  type ProviderObservationStatus,
  type ProviderOperationInput,
  type ProviderOperationKeyReuse,
  type ProviderOperationLookup,
  type ProviderPersistence,
  type ProviderPersistenceContext,
  type ProviderPersistenceFailure,
  type StoredProviderInstance,
  ProviderOperationKeyReused,
  credentialFailure,
  operationLookupFailure,
  persistenceFailure,
};
