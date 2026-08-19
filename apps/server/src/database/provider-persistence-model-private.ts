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
interface ProviderInstanceCursor {
  readonly createdAt: Date;
  readonly providerInstanceId: string;
}

interface ProviderInstanceListInput {
  readonly after?: ProviderInstanceCursor;
  readonly limit: number;
}

interface ProviderInstanceRecord {
  readonly configuredSecretKeys: readonly string[];
  readonly configuration: JsonObject;
  readonly createdAt: Date;
  readonly credentialsAvailable: boolean;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly id: string;
  readonly observation: Readonly<{
    readonly status: ProviderObservationStatus;
    readonly summary: string;
  }>;
  readonly providerTypeId: string;
  readonly revision: string;
  readonly syncPriority: number;
  readonly updatedAt: Date;
}

interface ProviderOperationInput {
  readonly administratorUserId: string;
  readonly canonicalRequest: Uint8Array;
  readonly method: ProviderMutationMethod;
  readonly operationId: string;
  readonly serializedResult?: JsonObject;
  readonly serializeResult?: (instance: ProviderInstanceRecord) => JsonObject;
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

interface ProviderInstanceUpdateInput {
  readonly carryObservationForward: boolean;
  readonly clearCredentialKeys: readonly string[];
  readonly configuration?: JsonObject;
  readonly credentialChanges: Readonly<Record<string, string>>;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly expectedRevision: string;
  readonly operation: ProviderOperationInput;
  readonly providerInstanceId: string;
  readonly providerTypeId: string;
  readonly revision: string;
  readonly syncPriority: number;
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

const STATUS_SUMMARY_NOT_OBSERVED = "Connection not yet observed";

const providerObservationForRevision = (
  input: Readonly<{
    readonly currentRevision: string;
    readonly observationRevision: string;
    readonly status: string;
    readonly summary: string;
  }>,
): ProviderInstanceRecord["observation"] => {
  if (
    input.status !== "authentication_failed" &&
    input.status !== "healthy" &&
    input.status !== "unavailable"
  ) {
    throw new Error("provider instance observation is invalid");
  }
  if (input.observationRevision !== input.currentRevision) {
    return { status: "unavailable", summary: STATUS_SUMMARY_NOT_OBSERVED };
  }
  return { status: input.status, summary: input.summary };
};

const taggedError = Data.TaggedError;
const ProviderPersistenceError = taggedError("ProviderPersistenceError")<Record<string, never>>;
const ProviderCredentialsUnavailable = taggedError("ProviderCredentialsUnavailable")<
  Record<string, never>
>;
const ProviderInstanceLimitReached = taggedError("ProviderInstanceLimitReached")<
  Record<string, never>
>;
const ProviderSyncPriorityConflict = taggedError("ProviderSyncPriorityConflict")<
  Record<string, never>
>;
type ProviderInstanceLimitFailure = InstanceType<typeof ProviderInstanceLimitReached>;
type ProviderSyncPriorityConflictFailure = InstanceType<typeof ProviderSyncPriorityConflict>;
const ProviderRevisionMismatch = taggedError("ProviderRevisionMismatch")<Record<string, never>>;
type ProviderRevisionMismatchFailure = InstanceType<typeof ProviderRevisionMismatch>;
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
  ) => Effect.Effect<
    ProviderInstanceRecord,
    ProviderInstanceLimitFailure | ProviderPersistenceFailure | ProviderSyncPriorityConflictFailure
  >;
  readonly updateInstance: (
    input: ProviderInstanceUpdateInput,
  ) => Effect.Effect<
    ProviderInstanceRecord,
    | ProviderPersistenceFailure
    | ProviderRevisionMismatchFailure
    | ProviderSyncPriorityConflictFailure
  >;
  readonly deleteInstance: (
    input: ProviderInstanceDeletionInput,
  ) => Effect.Effect<boolean, ProviderPersistenceFailure>;
  readonly listInstances: (
    input: ProviderInstanceListInput,
  ) => Effect.Effect<readonly ProviderInstanceRecord[], ProviderPersistenceFailure>;
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
  readonly loadInstanceRecord: (
    providerInstanceId: string,
  ) => Effect.Effect<ProviderInstanceRecord | undefined, ProviderPersistenceFailure>;
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
  type ProviderInstanceCursor,
  type ProviderInstanceListInput,
  type ProviderInstanceRecord,
  type ProviderInstanceLimitFailure,
  type ProviderInstanceInput,
  type ProviderInstanceUpdateInput,
  type ProviderRevisionMismatchFailure,
  type ProviderSyncPriorityConflictFailure,
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
  ProviderInstanceLimitReached,
  ProviderRevisionMismatch,
  ProviderSyncPriorityConflict,
  credentialFailure,
  operationLookupFailure,
  persistenceFailure,
  providerObservationForRevision,
};
