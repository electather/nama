// oxlint-disable import/max-dependencies, eslint/max-lines, eslint/max-lines-per-function, eslint/max-params, eslint/max-statements, eslint/no-continue, eslint/no-ternary, eslint/no-underscore-dangle, eslint/prefer-destructuring, unicorn/no-useless-undefined -- The deep provider-management owner keeps schema validation, secret splitting, candidate verification, idempotency, and both pagination state machines explicit in one security boundary.
import { randomUUID } from "node:crypto";

import { PluginConnectionStatus, PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import type { GetConnectionResponse } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Clock, Context, Data, Effect, Layer, Redacted, Semaphore } from "effect";
import type { Scope } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { persistenceFailure } from "../database/provider-persistence.ts";
import type {
  ProviderInstallationListInput,
  ProviderInstanceListInput,
  ProviderInstanceRecord,
  ProviderPersistence,
  ProviderPersistenceFailure,
  StoredProviderInstallation,
  StoredProviderInstance,
} from "../database/provider-persistence.ts";
import type { JsonObject, JsonValue } from "../database/provider-schema.ts";
import type {
  PluginCallFailure,
  PluginInstanceFenceMode,
  PluginSupervisorService,
} from "../plugin/model.ts";
import { PluginSupervisor } from "../plugin/supervisor.ts";
import {
  bundledProviderTypeIds,
  bundledProviders,
  validateBundledProviderRegistry,
} from "./bundled-provider-registry.ts";
import type { BundledProvider } from "./bundled-provider-registry.ts";
import { PageTokenInvalid, makePageTokenCodec } from "./page-token.ts";
import type { PageTokenCodec, PageTokenInvalidFailure } from "./page-token.ts";
import {
  configurationMatchesRestrictedSchema,
  isInstallationSchemaCompatible,
  normalizeDiscoveredPluginInfo,
} from "./restricted-schema.ts";
import type { DiscoveredPluginInfo } from "./restricted-schema.ts";

const ZERO = 0;
const LAST_ITEM = -1;
const DEFAULT_PAGE_SIZE = 50;
const MAXIMUM_PAGE_SIZE = 100;
const NEXT_ROW = 1;
const WRITER_GATE_PERMITS = 1;
const INSTANCE_CURSOR_KEY_COUNT = 2;
const PAGE_TOKEN_LIFETIME_MILLISECONDS = 900_000;
const CREATE_PROVIDER_INSTANCE_METHOD =
  "nama.api.v1.ProviderService.CreateProviderInstance" as const;
const UPDATE_PROVIDER_INSTANCE_METHOD =
  "nama.api.v1.ProviderService.UpdateProviderInstance" as const;
const DELETE_PROVIDER_INSTANCE_METHOD =
  "nama.api.v1.ProviderService.DeleteProviderInstance" as const;
const LIST_PROVIDER_INSTANCES_METHOD = "nama.api.v1.ProviderService.ListProviderInstances";
const NORMALIZED_PROVIDER_INSTANCE_QUERY = "{}";
const CANDIDATE_DEADLINE_MILLISECONDS = 5000;
const MAXIMUM_FIELD_VIOLATIONS = 50;
const STATUS_SUMMARY_CONNECTED = "Connected";
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
interface ProviderFieldViolation {
  readonly description: string;
  readonly field: string;
  readonly reason:
    | "CONFLICT"
    | "INVALID_FORMAT"
    | "OUT_OF_RANGE"
    | "REQUIRED"
    | "UNSUPPORTED_VALUE";
}

interface CreateProviderInstanceInput {
  readonly administratorId: string;
  readonly configuration: JsonObject;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly operationId: string;
  readonly providerTypeId: string;
  readonly syncPriority?: number;
}

interface UpdateProviderInstanceInput {
  readonly administratorId: string;
  readonly clearConfigurationFields: readonly string[];
  readonly configurationPatch: JsonObject;
  readonly displayName?: string;
  readonly enabled?: boolean;
  readonly expectedRevision: string;
  readonly operationId: string;
  readonly providerInstanceId: string;
  readonly syncPriority?: number;
}

interface DeleteProviderInstanceInput {
  readonly administratorId: string;
  readonly expectedRevision: string;
  readonly operationId: string;
  readonly providerInstanceId: string;
}

interface ListProviderInstancesInput {
  readonly administratorId: string;
  readonly pageSize: number;
  readonly pageToken: string;
}

interface ListProviderInstancesResult {
  readonly nextPageToken: string;
  readonly providerInstances: readonly ProviderInstanceRecord[];
}

interface GetProviderInstanceInput {
  readonly providerInstanceId: string;
}

interface VerifiedProviderCandidate {
  readonly principalReference: string;
}

// fallow-ignore-next-line code-duplication -- Owner-local public failures and persistence failures intentionally use the same Effect tagged-error idiom.
const taggedError = Data.TaggedError;
const ProviderValidationFailed = taggedError("ProviderValidationFailed")<{
  readonly violations: readonly ProviderFieldViolation[];
}>;
const ProviderResourceNotFound = taggedError("ProviderResourceNotFound")<Record<string, never>>;
const ProviderAuthenticationFailed = taggedError("ProviderAuthenticationFailed")<
  Record<string, never>
>;
// fallow-ignore-next-line code-duplication -- Public provider failures mirror persistence tags without coupling the owner modules.
const ProviderIncompatible = taggedError("ProviderIncompatible")<Record<string, never>>;
const ProviderUnavailable = taggedError("ProviderUnavailable")<Record<string, never>>;
const ProviderPluginUnavailable = taggedError("ProviderPluginUnavailable")<Record<string, never>>;
const ProviderInstanceLimitReached = taggedError("ProviderInstanceLimitReached")<
  Record<string, never>
>;
const IdempotencyKeyReused = taggedError("IdempotencyKeyReused")<Record<string, never>>;
const RevisionMismatch = taggedError("RevisionMismatch")<Record<string, never>>;
const ProviderUserChanged = taggedError("ProviderUserChanged")<Record<string, never>>;
const ProviderCredentialsUnavailable = taggedError("ProviderCredentialsUnavailable")<
  Record<string, never>
>;
const ProviderCommitAmbiguous = taggedError("ProviderCommitAmbiguous")<Record<string, never>>;
const ProviderInstanceBusy = taggedError("ProviderInstanceBusy")<Record<string, never>>;

type ProviderValidationFailure = InstanceType<typeof ProviderValidationFailed>;
type ProviderResourceNotFoundFailure = InstanceType<typeof ProviderResourceNotFound>;
type ProviderAuthenticationFailure = InstanceType<typeof ProviderAuthenticationFailed>;
type ProviderIncompatibleFailure = InstanceType<typeof ProviderIncompatible>;
type ProviderUnavailableFailure = InstanceType<typeof ProviderUnavailable>;
type ProviderPluginUnavailableFailure = InstanceType<typeof ProviderPluginUnavailable>;
type IdempotencyKeyReuseFailure = InstanceType<typeof IdempotencyKeyReused>;
type RevisionMismatchFailure = InstanceType<typeof RevisionMismatch>;
type ProviderUserChangedFailure = InstanceType<typeof ProviderUserChanged>;
type ProviderCredentialsUnavailableFailure = InstanceType<typeof ProviderCredentialsUnavailable>;
type ProviderCommitAmbiguousFailure = InstanceType<typeof ProviderCommitAmbiguous>;
type ProviderInstanceBusyFailure = InstanceType<typeof ProviderInstanceBusy>;
type ProviderMutationFailure =
  | IdempotencyKeyReuseFailure
  | ProviderAuthenticationFailure
  | ProviderCommitAmbiguousFailure
  | ProviderCredentialsUnavailableFailure
  | ProviderIncompatibleFailure
  | InstanceType<typeof ProviderInstanceLimitReached>
  | ProviderInstanceBusyFailure
  | ProviderPersistenceFailure
  | ProviderPluginUnavailableFailure
  | ProviderResourceNotFoundFailure
  | ProviderUnavailableFailure
  | ProviderUserChangedFailure
  | ProviderValidationFailure
  | RevisionMismatchFailure;

type CandidateVerification = (
  provider: BundledProvider,
  configuration: JsonObject,
  credentials: Readonly<Record<string, string>>,
) => Effect.Effect<
  VerifiedProviderCandidate,
  | PluginCallFailure
  | ProviderAuthenticationFailure
  | ProviderIncompatibleFailure
  | ProviderUnavailableFailure
>;

interface InstanceAdmissionFence {
  readonly open: (revision: string) => Effect.Effect<void>;
}

type InstanceCutoverFence = (
  providerInstanceId: string,
  mode: PluginInstanceFenceMode,
) => Effect.Effect<InstanceAdmissionFence, PluginCallFailure, Scope.Scope>;

interface InstanceActivityDeletionFence {
  readonly open: Effect.Effect<void>;
}

type InstanceActivityDeletionFenceAcquire = (
  providerInstanceId: string,
) => Effect.Effect<InstanceActivityDeletionFence, ProviderInstanceBusyFailure>;

const noProviderActivityFence: InstanceActivityDeletionFenceAcquire = () =>
  Effect.succeed({ open: Effect.void });

interface ProviderManagementService {
  readonly createProviderInstance: (
    input: CreateProviderInstanceInput,
  ) => Effect.Effect<ProviderInstanceRecord, ProviderMutationFailure>;
  readonly deleteProviderInstance: (
    input: DeleteProviderInstanceInput,
  ) => Effect.Effect<void, ProviderMutationFailure>;
  readonly getProviderInstance: (
    input: GetProviderInstanceInput,
  ) => Effect.Effect<
    ProviderInstanceRecord,
    ProviderPersistenceFailure | ProviderResourceNotFoundFailure
  >;
  readonly listProviderInstances: (
    input: ListProviderInstancesInput,
  ) => Effect.Effect<
    ListProviderInstancesResult,
    PageTokenInvalidFailure | ProviderPersistenceFailure
  >;
  readonly updateProviderInstance: (
    input: UpdateProviderInstanceInput,
  ) => Effect.Effect<ProviderInstanceRecord, ProviderMutationFailure>;
  readonly listProviderTypes: (
    input: ListProviderTypesInput,
  ) => Effect.Effect<ListProviderTypesResult, PageTokenInvalidFailure | ProviderPersistenceFailure>;
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
type ProviderDiscovery = (
  provider: (typeof bundledProviders)[number],
) => Effect.Effect<DiscoveredPluginInfo | undefined, PluginCallFailure>;
// fallow-ignore-next-line complexity -- Candidate response validation reduces every untrusted status/reference combination to one safe result.
const verifiedCandidateFromResponse = (
  response: GetConnectionResponse,
): Effect.Effect<
  VerifiedProviderCandidate,
  ProviderAuthenticationFailure | ProviderIncompatibleFailure | ProviderUnavailableFailure
> => {
  const connection = response.connection;
  if (
    connection?.status === PluginConnectionStatus.CONNECTED &&
    connection.providerUserReference !== undefined &&
    connection.providerUserReference.length > ZERO
  ) {
    return Effect.succeed({
      principalReference: connection.providerUserReference,
    });
  }
  switch (connection?.status) {
    case PluginConnectionStatus.AUTHENTICATION_FAILED: {
      return Effect.fail(new ProviderAuthenticationFailed({}));
    }
    case PluginConnectionStatus.UNREACHABLE: {
      return Effect.fail(new ProviderUnavailable({}));
    }
    case undefined:
    case PluginConnectionStatus.CONNECTED:
    case PluginConnectionStatus.INCOMPATIBLE:
    case PluginConnectionStatus.UNSPECIFIED: {
      return Effect.fail(new ProviderIncompatible({}));
    }
    default: {
      return Effect.fail(new ProviderIncompatible({}));
    }
  }
};

const verifyProviderCandidate = (
  supervisor: PluginSupervisorService,
  provider: BundledProvider,
  configuration: JsonObject,
  credentials: Readonly<Record<string, string>>,
) =>
  Effect.scoped(
    supervisor
      .supervise(provider.descriptor, { configuration, credentials, kind: "candidate" })
      .pipe(
        Effect.flatMap((plugin) =>
          plugin.call(PluginService.method.getConnection, {}, CANDIDATE_DEADLINE_MILLISECONDS),
        ),
        Effect.flatMap(verifiedCandidateFromResponse),
      ),
  );

const verifyMutationCandidate = (
  verifyCandidate: CandidateVerification,
  provider: BundledProvider,
  configuration: JsonObject,
  credentials: Readonly<Record<string, string>>,
) =>
  verifyCandidate(provider, configuration, credentials).pipe(
    Effect.mapError((failure) =>
      failure._tag === "PluginDeadlineExceeded" ||
      failure._tag === "PluginRpcError" ||
      failure._tag === "PluginUnavailable"
        ? new ProviderPluginUnavailable({})
        : failure,
    ),
  );

interface ProviderManagementDependencies {
  readonly discover: ProviderDiscovery;
  readonly fenceInstance: InstanceCutoverFence;
  readonly fenceActivities?: InstanceActivityDeletionFenceAcquire;
  readonly masterKey: string;
  readonly verifyCandidate?: CandidateVerification;
  readonly persistence: ProviderPersistence;
}

const storedInstancesMatchSchema = (
  persistence: ProviderPersistence,
  installation: StoredProviderInstallation,
): Effect.Effect<boolean, ProviderPersistenceFailure> =>
  persistence.loadInstallationConfigurations(installation.providerTypeId).pipe(
    Effect.map((configurations) =>
      configurations.every((configuration) =>
        configurationMatchesRestrictedSchema(installation.configurationSchema, configuration),
      ),
    ),
    Effect.catchTag("ProviderCredentialsUnavailable", () => Effect.succeed(false)),
  );

const reconcileProvider = (
  persistence: ProviderPersistence,
  discover: ProviderDiscovery,
  provider: (typeof bundledProviders)[number],
): Effect.Effect<ProviderDiscoveryStatus, ProviderPersistenceFailure> =>
  Effect.matchEffect(discover(provider), {
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
const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalJson = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    const items: readonly JsonValue[] = value;
    return `[${items.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const properties = Object.keys(value)
      .toSorted()
      .map((key) => {
        const child = value[key];
        if (child === undefined) {
          throw new TypeError("canonical JSON object contains undefined");
        }
        return `${JSON.stringify(key)}:${canonicalJson(child)}`;
      });
    return `{${properties.join(",")}}`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  throw new TypeError("canonical JSON contains an unsupported value");
};

const fieldViolation = (
  field: string,
  reason: ProviderFieldViolation["reason"],
): ProviderFieldViolation => {
  switch (reason) {
    case "INVALID_FORMAT": {
      return { description: "has an invalid format", field, reason };
    }
    case "OUT_OF_RANGE": {
      return { description: "is outside the permitted range", field, reason };
    }
    case "REQUIRED": {
      return { description: "is required", field, reason };
    }
    case "CONFLICT": {
      return { description: "conflicts with another value", field, reason };
    }
    case "UNSUPPORTED_VALUE": {
      return { description: "has an unsupported value", field, reason };
    }
    default: {
      throw new RangeError("unsupported provider field violation reason");
    }
  }
};

// fallow-ignore-next-line complexity -- Field reasons preserve safe, provider-neutral details across schema types and constraints.
const propertyFailureReason = (
  value: JsonValue,
  property: JsonObject,
): ProviderFieldViolation["reason"] => {
  if (
    property["type"] === "string" &&
    typeof value === "string" &&
    property["format"] === "uri" &&
    !URL.canParse(value)
  ) {
    return "INVALID_FORMAT";
  }
  if (property["type"] === "string" && typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (
      (typeof property["minLength"] === "number" && bytes < property["minLength"]) ||
      (typeof property["maxLength"] === "number" && bytes > property["maxLength"])
    ) {
      return "OUT_OF_RANGE";
    }
  }
  return "UNSUPPORTED_VALUE";
};

interface SplitConfiguration {
  readonly configuration: JsonObject;
  readonly credentials: Readonly<Record<string, string>>;
}

// fallow-ignore-next-line complexity -- The schema trust boundary collects bounded violations and splits secrets in one pass.
const splitProviderConfiguration = (
  schema: JsonObject,
  submitted: JsonObject,
): SplitConfiguration | ProviderFieldViolation[] => {
  const properties = schema["properties"];
  const required = schema["required"];
  if (!isJsonObject(properties) || !Array.isArray(required)) {
    return [fieldViolation("configuration", "UNSUPPORTED_VALUE")];
  }
  const requiredValues: readonly unknown[] = required;
  const violations: ProviderFieldViolation[] = [];
  for (const key of requiredValues) {
    if (
      typeof key === "string" &&
      !Object.hasOwn(submitted, key) &&
      violations.length < MAXIMUM_FIELD_VIOLATIONS
    ) {
      violations.push(fieldViolation(`configuration.${key}`, "REQUIRED"));
    }
  }
  for (const key of Object.keys(submitted).toSorted()) {
    if (violations.length === MAXIMUM_FIELD_VIOLATIONS) {
      break;
    }
    const property = properties[key];
    if (!isJsonObject(property)) {
      violations.push(fieldViolation(`configuration.${key}`, "UNSUPPORTED_VALUE"));
      continue;
    }
    const propertySchema: JsonObject = {
      additionalProperties: false,
      properties: { [key]: property },
      required: [key],
      type: "object",
    };
    const submittedValue = submitted[key];
    if (submittedValue === undefined) {
      violations.push(fieldViolation(`configuration.${key}`, "UNSUPPORTED_VALUE"));
      continue;
    }
    if (
      !configurationMatchesRestrictedSchema(propertySchema, {
        [key]: submittedValue,
      })
    ) {
      violations.push(
        fieldViolation(`configuration.${key}`, propertyFailureReason(submittedValue, property)),
      );
    }
  }
  if (violations.length > ZERO || !configurationMatchesRestrictedSchema(schema, submitted)) {
    return violations.length > ZERO
      ? violations
      : [fieldViolation("configuration", "OUT_OF_RANGE")];
  }
  const configuration: Record<string, JsonValue> = {};
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    const property = properties[key];
    if (isJsonObject(property) && property["writeOnly"] === true) {
      if (typeof value !== "string") {
        return [fieldViolation(`configuration.${key}`, "UNSUPPORTED_VALUE")];
      }
      credentials[key] = value;
    } else {
      configuration[key] = value;
    }
  }
  return { configuration, credentials };
};

interface MergedUpdateConfiguration extends SplitConfiguration {
  readonly clearCredentialKeys: readonly string[];
  readonly credentialChanges: Readonly<Record<string, string>>;
}

interface UpdateConfigurationSchema {
  readonly properties: JsonObject;
  readonly required: ReadonlySet<string>;
}

const updateConfigurationSchema = (schema: JsonObject): UpdateConfigurationSchema | undefined => {
  const properties = schema["properties"];
  const requiredValues = schema["required"];
  if (!isJsonObject(properties) || !Array.isArray(requiredValues)) {
    return undefined;
  }
  return {
    properties,
    required: new Set(requiredValues.filter((value) => typeof value === "string")),
  };
};

const configurationClearViolations = (
  schema: UpdateConfigurationSchema,
  input: UpdateProviderInstanceInput,
): readonly ProviderFieldViolation[] => {
  const violations: ProviderFieldViolation[] = [];
  for (const [index, key] of input.clearConfigurationFields.entries()) {
    const clearField = `clear_configuration_fields[${String(index)}]`;
    if (!Object.hasOwn(schema.properties, key) || schema.required.has(key)) {
      violations.push(fieldViolation(clearField, "UNSUPPORTED_VALUE"));
    }
    if (Object.hasOwn(input.configurationPatch, key)) {
      violations.push(
        fieldViolation(`configuration_patch.${key}`, "CONFLICT"),
        fieldViolation(clearField, "CONFLICT"),
      );
    }
  }
  return violations;
};

const updateConfigurationViolations = (
  split: readonly ProviderFieldViolation[],
  input: UpdateProviderInstanceInput,
): readonly ProviderFieldViolation[] => {
  const cleared = new Set(input.clearConfigurationFields);
  return split.flatMap((violation) => {
    const key = violation.field.startsWith("configuration.")
      ? violation.field.slice("configuration.".length)
      : undefined;
    if (key !== undefined && cleared.has(key)) {
      return [];
    }
    return [
      key !== undefined && Object.hasOwn(input.configurationPatch, key)
        ? { ...violation, field: `configuration_patch.${key}` }
        : violation,
    ];
  });
};

const orderedProviderViolations = (
  violations: readonly ProviderFieldViolation[],
): ProviderFieldViolation[] =>
  [...violations]
    .toSorted((left, right) => {
      if (left.field < right.field) {
        return LAST_ITEM;
      }
      if (left.field > right.field) {
        return NEXT_ROW;
      }
      if (left.reason < right.reason) {
        return LAST_ITEM;
      }
      if (left.reason > right.reason) {
        return NEXT_ROW;
      }
      return ZERO;
    })
    .slice(ZERO, MAXIMUM_FIELD_VIOLATIONS);

const changedCredentials = (
  properties: JsonObject,
  input: UpdateProviderInstanceInput,
): Readonly<Record<string, string>> => {
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.configurationPatch)) {
    const property = properties[key];
    if (isJsonObject(property) && property["writeOnly"] === true && typeof value === "string") {
      credentials[key] = value;
    }
  }
  return credentials;
};

const clearedCredentials = (
  properties: JsonObject,
  input: UpdateProviderInstanceInput,
): readonly string[] =>
  input.clearConfigurationFields.filter((key) => {
    const property = properties[key];
    return isJsonObject(property) && property["writeOnly"] === true;
  });

const mergeProviderConfigurationUpdate = (
  schema: JsonObject,
  stored: StoredProviderInstance,
  input: UpdateProviderInstanceInput,
): MergedUpdateConfiguration | ProviderFieldViolation[] => {
  const updateSchema = updateConfigurationSchema(schema);
  if (updateSchema === undefined) {
    return [fieldViolation("configuration_patch", "UNSUPPORTED_VALUE")];
  }
  const clearViolations = configurationClearViolations(updateSchema, input);
  const merged: Record<string, JsonValue> = {
    ...stored.configuration,
    ...stored.credentials,
    ...input.configurationPatch,
  };
  for (const key of input.clearConfigurationFields) {
    delete merged[key];
  }
  const split = splitProviderConfiguration(schema, merged);
  if (Array.isArray(split)) {
    return orderedProviderViolations([
      ...clearViolations,
      ...updateConfigurationViolations(split, input),
    ]);
  }
  if (clearViolations.length > ZERO) {
    return orderedProviderViolations(clearViolations);
  }
  return {
    ...split,
    clearCredentialKeys: clearedCredentials(updateSchema.properties, input),
    credentialChanges: changedCredentials(updateSchema.properties, input),
  };
};

const serializeInstanceRecord = (instance: ProviderInstanceRecord): JsonObject => ({
  configuration: instance.configuration,
  configured_secret_keys: instance.configuredSecretKeys,
  created_at: instance.createdAt.toISOString(),
  credentials_available: instance.credentialsAvailable,
  display_name: instance.displayName,
  enabled: instance.enabled,
  id: instance.id,
  observation_status: instance.observation.status,
  observation_summary: instance.observation.summary,
  provider_type_id: instance.providerTypeId,
  revision: instance.revision,
  sync_priority: instance.syncPriority,
  updated_at: instance.updatedAt.toISOString(),
});

const stringArray = (value: JsonValue | undefined): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

// fallow-ignore-next-line complexity -- Durable idempotency replay validates every safe result field before public reconstruction.
const deserializeInstanceRecord = (value: JsonObject): ProviderInstanceRecord | undefined => {
  const configuration = value["configuration"];
  const configuredSecretKeys = stringArray(value["configured_secret_keys"]);
  const createdAtValue = value["created_at"];
  const updatedAtValue = value["updated_at"];
  const observationStatus = value["observation_status"];
  if (
    !isJsonObject(configuration) ||
    configuredSecretKeys === undefined ||
    typeof createdAtValue !== "string" ||
    typeof updatedAtValue !== "string" ||
    typeof value["credentials_available"] !== "boolean" ||
    typeof value["display_name"] !== "string" ||
    typeof value["enabled"] !== "boolean" ||
    typeof value["id"] !== "string" ||
    (observationStatus !== "authentication_failed" &&
      observationStatus !== "healthy" &&
      observationStatus !== "unavailable") ||
    typeof value["observation_summary"] !== "string" ||
    typeof value["provider_type_id"] !== "string" ||
    typeof value["revision"] !== "string" ||
    typeof value["sync_priority"] !== "number"
  ) {
    return undefined;
  }
  const createdAt = new Date(createdAtValue);
  const updatedAt = new Date(updatedAtValue);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(updatedAt.getTime())) {
    return undefined;
  }
  return {
    configuration,
    configuredSecretKeys,
    createdAt,
    credentialsAvailable: value["credentials_available"],
    displayName: value["display_name"],
    enabled: value["enabled"],
    id: value["id"],
    observation: {
      status: observationStatus,
      summary: value["observation_summary"],
    },
    providerTypeId: value["provider_type_id"],
    revision: value["revision"],
    syncPriority: value["sync_priority"],
    updatedAt,
  };
};

const instanceCursor = (record: ProviderInstanceRecord): string =>
  JSON.stringify({
    created_at: record.createdAt.toISOString(),
    provider_instance_id: record.id,
  });

const parseInstanceCursor = (cursor: string): ProviderInstanceListInput["after"] | undefined => {
  if (cursor.length === ZERO) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(cursor);
    if (!isJsonObject(value)) {
      throw new Error("invalid provider instance cursor");
    }
    const keys = Object.keys(value);
    const createdAtValue = value["created_at"];
    const providerInstanceId = value["provider_instance_id"];
    const createdAt = typeof createdAtValue === "string" ? new Date(createdAtValue) : new Date(NaN);
    if (
      keys.length !== INSTANCE_CURSOR_KEY_COUNT ||
      typeof providerInstanceId !== "string" ||
      providerInstanceId.length === ZERO ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid provider instance cursor");
    }
    return { createdAt, providerInstanceId };
  } catch {
    throw new PageTokenInvalid({});
  }
};

const providerInstanceCursor = (
  input: ListProviderInstancesInput,
  now: number,
  pageSize: number,
  pageTokens: PageTokenCodec,
): Effect.Effect<string, PageTokenInvalidFailure> =>
  Effect.try({
    catch: pageTokenFailure,
    try: () =>
      input.pageToken.length === ZERO
        ? ""
        : pageTokens.decode({
            administratorId: input.administratorId,
            method: LIST_PROVIDER_INSTANCES_METHOD,
            now,
            pageSize,
            query: NORMALIZED_PROVIDER_INSTANCE_QUERY,
            token: input.pageToken,
          }),
  });

// fallow-ignore-next-line code-duplication -- Instance and type pagination intentionally retain separate method bindings and cursor shapes.
const listProviderInstances = (
  persistence: ProviderPersistence,
  pageTokens: PageTokenCodec,
  input: ListProviderInstancesInput,
): Effect.Effect<
  ListProviderInstancesResult,
  PageTokenInvalidFailure | ProviderPersistenceFailure
> =>
  Effect.gen(function* listProviderInstancesEffect() {
    const pageSize = normalizedPageSize(input.pageSize);
    if (pageSize === ZERO || input.administratorId.length === ZERO) {
      return yield* Effect.fail(new PageTokenInvalid({}));
    }
    const now = yield* Clock.currentTimeMillis;
    const cursor = yield* providerInstanceCursor(input, now, pageSize, pageTokens);
    const after = yield* Effect.try({
      catch: pageTokenFailure,
      try: () => parseInstanceCursor(cursor),
    });
    const providerInstances = yield* persistence.listInstances({
      ...(after === undefined ? {} : { after }),
      limit: pageSize + NEXT_ROW,
    });
    const page = providerInstances.slice(ZERO, pageSize);
    if (providerInstances.length <= pageSize) {
      return { nextPageToken: "", providerInstances: page };
    }
    const last = page.at(LAST_ITEM);
    if (last === undefined) {
      return yield* Effect.fail(new PageTokenInvalid({}));
    }
    const nextPageToken = yield* Effect.try({
      catch: pageTokenFailure,
      try: () =>
        pageTokens.encode({
          administratorId: input.administratorId,
          cursor: instanceCursor(last),
          expiresAt: now + PAGE_TOKEN_LIFETIME_MILLISECONDS,
          method: LIST_PROVIDER_INSTANCES_METHOD,
          pageSize,
          query: NORMALIZED_PROVIDER_INSTANCE_QUERY,
        }),
    });
    return { nextPageToken, providerInstances: page };
  });

const getProviderInstance = (
  persistence: ProviderPersistence,
  input: GetProviderInstanceInput,
): Effect.Effect<
  ProviderInstanceRecord,
  ProviderPersistenceFailure | ProviderResourceNotFoundFailure
> =>
  persistence
    .loadInstanceRecord(input.providerInstanceId)
    .pipe(
      Effect.flatMap((instance) =>
        instance === undefined
          ? Effect.fail(new ProviderResourceNotFound({}))
          : Effect.succeed(instance),
      ),
    );

const expectedProviderInstance = (
  persistence: ProviderPersistence,
  input: Readonly<{ readonly expectedRevision: string; readonly providerInstanceId: string }>,
): Effect.Effect<
  ProviderInstanceRecord,
  ProviderPersistenceFailure | ProviderResourceNotFoundFailure | RevisionMismatchFailure
> =>
  getProviderInstance(persistence, { providerInstanceId: input.providerInstanceId }).pipe(
    Effect.flatMap((instance) =>
      instance.revision === input.expectedRevision
        ? Effect.succeed(instance)
        : Effect.fail(new RevisionMismatch({})),
    ),
  );

const operationResult = (
  persistence: ProviderPersistence,
  input: Readonly<{ readonly administratorId: string; readonly operationId: string }>,
  canonicalRequest: Uint8Array,
  method:
    | "nama.api.v1.ProviderService.CreateProviderInstance"
    | "nama.api.v1.ProviderService.UpdateProviderInstance",
): Effect.Effect<
  ProviderInstanceRecord | undefined,
  IdempotencyKeyReuseFailure | ProviderPersistenceFailure
> =>
  persistence
    .readOperationResult({
      administratorUserId: input.administratorId,
      canonicalRequest,
      method,
      operationId: input.operationId,
    })
    .pipe(
      Effect.mapError((failure) =>
        failure._tag === "ProviderOperationKeyReused" ? new IdempotencyKeyReused({}) : failure,
      ),
      Effect.flatMap((serialized) => {
        if (serialized === undefined) {
          return Effect.succeed(undefined);
        }
        const instance = deserializeInstanceRecord(serialized);
        return instance === undefined
          ? Effect.die(new Error("invalid durable provider operation result"))
          : Effect.succeed(instance);
      }),
    );

const canonicalCreateRequest = (input: CreateProviderInstanceInput): Buffer =>
  Buffer.from(
    canonicalJson({
      configuration: input.configuration,
      display_name: input.displayName,
      enabled: input.enabled,
      provider_type_id: input.providerTypeId,
      sync_priority: input.syncPriority ?? "absent",
    }),
    "utf8",
  );

const createProviderInstance = (
  persistence: ProviderPersistence,
  providerStatuses: ReadonlyMap<string, ProviderDiscoveryStatus>,
  verifyCandidate: CandidateVerification,
  input: CreateProviderInstanceInput,
): Effect.Effect<ProviderInstanceRecord, ProviderMutationFailure> =>
  Effect.acquireUseRelease(
    Effect.sync(() => canonicalCreateRequest(input)),
    (canonicalRequest) =>
      Effect.gen(function* createProviderInstanceEffect() {
        const existing = yield* operationResult(
          persistence,
          input,
          canonicalRequest,
          CREATE_PROVIDER_INSTANCE_METHOD,
        );
        if (existing !== undefined) {
          return existing;
        }
        const provider = bundledProviders.find(
          (candidate) => candidate.providerTypeId === input.providerTypeId,
        );
        const installation = yield* persistence.loadInstallation(input.providerTypeId);
        if (provider === undefined || installation === undefined) {
          return yield* Effect.fail(new ProviderResourceNotFound({}));
        }
        if (providerStatuses.get(input.providerTypeId) !== "available") {
          return yield* Effect.fail(new ProviderPluginUnavailable({}));
        }
        const split = splitProviderConfiguration(
          installation.configurationSchema,
          input.configuration,
        );
        if (Array.isArray(split)) {
          return yield* Effect.fail(
            new ProviderValidationFailed({
              violations: split,
            }),
          );
        }
        const verified = yield* verifyMutationCandidate(
          verifyCandidate,
          provider,
          split.configuration,
          split.credentials,
        );
        const id = randomUUID();
        const revision = randomUUID();
        const create = persistence.createInstance({
          configuration: split.configuration,
          credentials: split.credentials,
          displayName: input.displayName,
          enabled: input.enabled,
          id,
          observation: { status: "healthy", summary: STATUS_SUMMARY_CONNECTED },
          operation: {
            administratorUserId: input.administratorId,
            canonicalRequest,
            method: CREATE_PROVIDER_INSTANCE_METHOD,
            operationId: input.operationId,
            serializeResult: serializeInstanceRecord,
          },
          principalReference: verified.principalReference,
          providerTypeId: input.providerTypeId,
          revision,
          ...(input.syncPriority === undefined ? {} : { syncPriority: input.syncPriority }),
        });
        return yield* create.pipe(
          Effect.catchTag("ProviderInstanceLimitReached", () =>
            Effect.fail(new ProviderInstanceLimitReached({})),
          ),
          Effect.catchTag("ProviderSyncPriorityConflict", () =>
            Effect.fail(
              new ProviderValidationFailed({
                violations: [fieldViolation("sync_priority", "CONFLICT")],
              }),
            ),
          ),
          Effect.catchTag("ProviderPersistenceError", (failure) =>
            operationResult(
              persistence,
              input,
              canonicalRequest,
              CREATE_PROVIDER_INSTANCE_METHOD,
            ).pipe(
              Effect.flatMap((committed) =>
                committed === undefined ? Effect.fail(failure) : Effect.succeed(committed),
              ),
            ),
          ),
        );
      }),
    (canonicalRequest) => Effect.sync(() => canonicalRequest.fill(ZERO)),
  );

const canonicalOptionalValue = (value: JsonValue | undefined): JsonObject => {
  if (value === undefined) {
    return { present: false };
  }
  return { present: true, value };
};

const canonicalUpdateRequest = (input: UpdateProviderInstanceInput): Buffer =>
  Buffer.from(
    canonicalJson({
      clear_configuration_fields: [...input.clearConfigurationFields].toSorted(),
      configuration_patch: input.configurationPatch,
      display_name: canonicalOptionalValue(input.displayName),
      enabled: canonicalOptionalValue(input.enabled),
      expected_revision: input.expectedRevision,
      provider_instance_id: input.providerInstanceId,
      sync_priority: canonicalOptionalValue(input.syncPriority),
    }),
    "utf8",
  );

interface ProviderCandidateUpdateInput {
  readonly current: ProviderInstanceRecord;
  readonly hasConfigurationChange: boolean;
  readonly input: UpdateProviderInstanceInput;
  readonly persistence: ProviderPersistence;
  readonly providerStatuses: ReadonlyMap<string, ProviderDiscoveryStatus>;
  readonly reenabled: boolean;
  readonly verifyCandidate: CandidateVerification;
}

const prepareProviderUpdateCandidate = ({
  current,
  hasConfigurationChange,
  input,
  persistence,
  providerStatuses,
  reenabled,
  verifyCandidate,
}: ProviderCandidateUpdateInput): Effect.Effect<
  MergedUpdateConfiguration | undefined,
  ProviderMutationFailure
> =>
  Effect.gen(function* prepareCandidateUpdate() {
    if (!hasConfigurationChange && !reenabled) {
      return undefined;
    }
    const stored = yield* persistence
      .loadInstance(input.providerInstanceId)
      .pipe(
        Effect.catchTag("ProviderCredentialsUnavailable", () =>
          Effect.fail(new ProviderCredentialsUnavailable({})),
        ),
      );
    const installation = yield* persistence.loadInstallation(current.providerTypeId);
    const provider = bundledProviders.find(
      (candidate) => candidate.providerTypeId === current.providerTypeId,
    );
    if (installation === undefined || provider === undefined) {
      return yield* Effect.fail(new ProviderResourceNotFound({}));
    }
    if (providerStatuses.get(current.providerTypeId) !== "available") {
      return yield* Effect.fail(new ProviderPluginUnavailable({}));
    }
    let preparedConfiguration: MergedUpdateConfiguration = {
      clearCredentialKeys: [],
      configuration: stored.configuration,
      credentialChanges: {},
      credentials: stored.credentials,
    };
    if (hasConfigurationChange) {
      const merged = mergeProviderConfigurationUpdate(
        installation.configurationSchema,
        stored,
        input,
      );
      if (Array.isArray(merged)) {
        return yield* Effect.fail(new ProviderValidationFailed({ violations: merged }));
      }
      preparedConfiguration = merged;
    }
    const verified = yield* verifyMutationCandidate(
      verifyCandidate,
      provider,
      preparedConfiguration.configuration,
      preparedConfiguration.credentials,
    );
    const samePrincipal = yield* persistence
      .matchesPrincipal(input.providerInstanceId, verified.principalReference)
      .pipe(
        Effect.catchTag("ProviderCredentialsUnavailable", () =>
          Effect.fail(new ProviderCredentialsUnavailable({})),
        ),
      );
    if (!samePrincipal) {
      return yield* Effect.fail(new ProviderUserChanged({}));
    }
    return preparedConfiguration;
  });

interface ProviderUpdateCommitInput {
  readonly ambiguousInstances: Set<string>;
  readonly canonicalRequest: Uint8Array;
  readonly hasConfigurationChange: boolean;
  readonly input: UpdateProviderInstanceInput;
  readonly persistence: ProviderPersistence;
  readonly preparedConfiguration: MergedUpdateConfiguration | undefined;
  readonly reenabled: boolean;
  readonly fenceInstance: InstanceCutoverFence;
}

interface ProviderUpdateResolution {
  pretransactionFailure: boolean;
}

const recoverProviderUpdateCommit = (
  { ambiguousInstances, canonicalRequest, input, persistence }: ProviderUpdateCommitInput,
  admissionFence: InstanceAdmissionFence,
) => {
  ambiguousInstances.add(input.providerInstanceId);
  const ambiguousFailure = Effect.fail(new ProviderCommitAmbiguous({}));
  return operationResult(
    persistence,
    input,
    canonicalRequest,
    UPDATE_PROVIDER_INSTANCE_METHOD,
  ).pipe(
    Effect.flatMap((durableResult) => {
      if (durableResult !== undefined) {
        ambiguousInstances.delete(input.providerInstanceId);
        return Effect.succeed(durableResult);
      }
      return persistence.loadInstanceRecord(input.providerInstanceId).pipe(
        Effect.flatMap((current) => {
          ambiguousInstances.delete(input.providerInstanceId);
          if (current?.enabled === true) {
            return admissionFence.open(current.revision).pipe(Effect.andThen(ambiguousFailure));
          }
          return ambiguousFailure;
        }),
      );
    }),
    Effect.catchTag("ProviderPersistenceError", () => ambiguousFailure),
  );
};

interface ResolvedProviderUpdate {
  readonly clearCredentialKeys: readonly string[];
  readonly credentialChanges: Readonly<Record<string, string>>;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly syncPriority: number;
}

const resolvedProviderUpdate = (
  commit: ProviderUpdateCommitInput,
  lockedCurrent: ProviderInstanceRecord,
): ResolvedProviderUpdate => ({
  clearCredentialKeys: commit.preparedConfiguration?.clearCredentialKeys ?? [],
  credentialChanges: commit.preparedConfiguration?.credentialChanges ?? {},
  displayName: commit.input.displayName ?? lockedCurrent.displayName,
  enabled: commit.input.enabled ?? lockedCurrent.enabled,
  syncPriority: commit.input.syncPriority ?? lockedCurrent.syncPriority,
});

const providerUpdatePersistenceInput = (
  commit: ProviderUpdateCommitInput,
  lockedCurrent: ProviderInstanceRecord,
): Parameters<ProviderPersistence["updateInstance"]>[typeof ZERO] => {
  const { canonicalRequest, hasConfigurationChange, input, preparedConfiguration } = commit;
  const resolved = resolvedProviderUpdate(commit, lockedCurrent);
  const configurationUpdate: { configuration?: JsonObject } = {};
  if (hasConfigurationChange && preparedConfiguration !== undefined) {
    configurationUpdate.configuration = preparedConfiguration.configuration;
  }
  return {
    ...configurationUpdate,
    carryObservationForward: !hasConfigurationChange && !commit.reenabled,
    clearCredentialKeys: resolved.clearCredentialKeys,
    credentialChanges: resolved.credentialChanges,
    displayName: resolved.displayName,
    enabled: resolved.enabled,
    expectedRevision: input.expectedRevision,
    operation: {
      administratorUserId: input.administratorId,
      canonicalRequest,
      method: UPDATE_PROVIDER_INSTANCE_METHOD,
      operationId: input.operationId,
      serializeResult: serializeInstanceRecord,
    },
    providerInstanceId: input.providerInstanceId,
    providerTypeId: lockedCurrent.providerTypeId,
    revision: randomUUID(),
    syncPriority: resolved.syncPriority,
  };
};

const persistProviderUpdate = (
  commit: ProviderUpdateCommitInput,
  lockedCurrent: ProviderInstanceRecord,
  admissionFence: InstanceAdmissionFence,
  resolution: ProviderUpdateResolution,
) =>
  commit.persistence.updateInstance(providerUpdatePersistenceInput(commit, lockedCurrent)).pipe(
    Effect.catchTag("ProviderRevisionMismatch", () => Effect.fail(new RevisionMismatch({}))),
    Effect.catchTag("ProviderSyncPriorityConflict", () =>
      Effect.fail(
        new ProviderValidationFailed({
          violations: [fieldViolation("sync_priority", "CONFLICT")],
        }),
      ),
    ),
    Effect.catchTag("ProviderPersistenceError", () =>
      recoverProviderUpdateCommit(commit, admissionFence),
    ),
    Effect.catchTag("ProviderUpdatePreparationFailed", () => {
      resolution.pretransactionFailure = true;
      const failure = Effect.fail(persistenceFailure());
      return failure;
    }),
  );

const reopenFailedProviderUpdate = (
  failure: ProviderMutationFailure,
  persistence: ProviderPersistence,
  lockedCurrent: ProviderInstanceRecord,
  admissionFence: InstanceAdmissionFence,
  pretransactionFailure: boolean,
): Effect.Effect<void, ProviderCommitAmbiguousFailure> => {
  if (pretransactionFailure || failure._tag === "ProviderValidationFailed") {
    return lockedCurrent.enabled ? admissionFence.open(lockedCurrent.revision) : Effect.void;
  }
  return persistence.loadInstanceRecord(lockedCurrent.id).pipe(
    Effect.flatMap((current) =>
      current?.enabled === true ? admissionFence.open(current.revision) : Effect.void,
    ),
    Effect.catchTag("ProviderPersistenceError", () => Effect.fail(new ProviderCommitAmbiguous({}))),
  );
};

const recoverReplayAdmission = (
  ambiguousInstances: Set<string>,
  fenceInstance: InstanceCutoverFence,
  input: UpdateProviderInstanceInput,
  result: ProviderInstanceRecord,
): Effect.Effect<void, ProviderPluginUnavailableFailure, Scope.Scope> =>
  Effect.suspend(() => {
    if (!ambiguousInstances.has(input.providerInstanceId)) {
      return Effect.void;
    }
    return Effect.gen(function* reopenReplayRevision() {
      const admissionFence = yield* fenceInstance(input.providerInstanceId, "admission-only").pipe(
        Effect.mapError(() => new ProviderPluginUnavailable({})),
      );
      if (result.enabled) {
        yield* admissionFence.open(result.revision);
      }
      ambiguousInstances.delete(input.providerInstanceId);
    });
  });

const commitProviderUpdate = (
  commit: ProviderUpdateCommitInput,
): Effect.Effect<ProviderInstanceRecord, ProviderMutationFailure, Scope.Scope> =>
  Effect.gen(function* commitPreparedProviderUpdate() {
    const {
      ambiguousInstances,
      canonicalRequest,
      hasConfigurationChange,
      input,
      persistence,
      reenabled,
      fenceInstance,
    } = commit;
    const recoveringAmbiguity = ambiguousInstances.has(input.providerInstanceId);
    const committedReplay = yield* operationResult(
      persistence,
      input,
      canonicalRequest,
      UPDATE_PROVIDER_INSTANCE_METHOD,
    );
    if (committedReplay !== undefined) {
      yield* recoverReplayAdmission(ambiguousInstances, fenceInstance, input, committedReplay);
      return committedReplay;
    }
    const lockedCurrent = yield* expectedProviderInstance(persistence, input);
    if (recoveringAmbiguity) {
      ambiguousInstances.delete(input.providerInstanceId);
    }
    const fenceMode: PluginInstanceFenceMode =
      hasConfigurationChange || reenabled || (lockedCurrent.enabled && input.enabled === false)
        ? "retire-current"
        : "admission-only";
    const admissionFence = yield* fenceInstance(input.providerInstanceId, fenceMode).pipe(
      Effect.mapError(() => new ProviderPluginUnavailable({})),
    );
    const resolution: ProviderUpdateResolution = { pretransactionFailure: false };
    return yield* persistProviderUpdate(commit, lockedCurrent, admissionFence, resolution).pipe(
      Effect.matchEffect({
        onFailure: (failure) =>
          reopenFailedProviderUpdate(
            failure,
            persistence,
            lockedCurrent,
            admissionFence,
            resolution.pretransactionFailure,
          ).pipe(Effect.andThen(Effect.fail(failure))),
        onSuccess: (result) =>
          result.enabled
            ? admissionFence.open(result.revision).pipe(Effect.as(result))
            : Effect.succeed(result),
      }),
    );
  });

interface InitialProviderUpdateInput {
  readonly canonicalRequest: Uint8Array;
  readonly input: UpdateProviderInstanceInput;
  readonly persistence: ProviderPersistence;
}

type InitialProviderUpdate =
  | Readonly<{ readonly kind: "replay"; readonly result: ProviderInstanceRecord }>
  | Readonly<{
      readonly current: ProviderInstanceRecord;
      readonly hasConfigurationChange: boolean;
      readonly kind: "update";
      readonly reenabled: boolean;
    }>;

const loadInitialProviderUpdate = ({
  canonicalRequest,
  input,
  persistence,
}: InitialProviderUpdateInput): Effect.Effect<InitialProviderUpdate, ProviderMutationFailure> =>
  Effect.gen(function* loadProviderUpdate() {
    const replay = yield* operationResult(
      persistence,
      input,
      canonicalRequest,
      UPDATE_PROVIDER_INSTANCE_METHOD,
    );
    if (replay !== undefined) {
      return { kind: "replay" as const, result: replay };
    }
    const current = yield* expectedProviderInstance(persistence, input);
    const hasConfigurationChange =
      Object.keys(input.configurationPatch).length > ZERO ||
      input.clearConfigurationFields.length > ZERO;
    if (
      input.displayName === undefined &&
      input.enabled === undefined &&
      input.syncPriority === undefined &&
      !hasConfigurationChange
    ) {
      return yield* Effect.fail(
        new ProviderValidationFailed({
          violations: [fieldViolation("configuration_patch", "REQUIRED")],
        }),
      );
    }
    return {
      current,
      hasConfigurationChange,
      kind: "update" as const,
      reenabled: !current.enabled && input.enabled === true,
    };
  });

const normalizeProviderUpdateFailure = (
  failure: ProviderMutationFailure,
  ambiguousInstances: ReadonlySet<string>,
  providerInstanceId: string,
): ProviderMutationFailure => {
  if (failure._tag === "ProviderPersistenceError" && ambiguousInstances.has(providerInstanceId)) {
    return new ProviderCommitAmbiguous({});
  }
  return failure;
};

const updateProviderInstance = (
  persistence: ProviderPersistence,
  ambiguousInstances: Set<string>,
  providerStatuses: ReadonlyMap<string, ProviderDiscoveryStatus>,
  verifyCandidate: CandidateVerification,
  fenceInstance: InstanceCutoverFence,
  gate: Semaphore.Semaphore,
  input: UpdateProviderInstanceInput,
): Effect.Effect<ProviderInstanceRecord, ProviderMutationFailure> =>
  Effect.acquireUseRelease(
    Effect.sync(() => canonicalUpdateRequest(input)),
    (canonicalRequest) =>
      Effect.gen(function* prepareProviderUpdate() {
        const initial = yield* loadInitialProviderUpdate({
          canonicalRequest,
          input,
          persistence,
        });
        if (initial.kind === "replay") {
          if (!ambiguousInstances.has(input.providerInstanceId)) {
            return initial.result;
          }
          const recovery = recoverReplayAdmission(
            ambiguousInstances,
            fenceInstance,
            input,
            initial.result,
          ).pipe(Effect.as(initial.result));
          return yield* gate.withPermits(WRITER_GATE_PERMITS)(
            Effect.uninterruptible(Effect.scoped(recovery)),
          );
        }
        const preparedConfiguration = yield* prepareProviderUpdateCandidate({
          current: initial.current,
          hasConfigurationChange: initial.hasConfigurationChange,
          input,
          persistence,
          providerStatuses,
          reenabled: initial.reenabled,
          verifyCandidate,
        });
        const commit = commitProviderUpdate({
          ambiguousInstances,
          canonicalRequest,
          fenceInstance,
          hasConfigurationChange: initial.hasConfigurationChange,
          input,
          persistence,
          preparedConfiguration,
          reenabled: initial.reenabled,
        });
        const scopedCommit = Effect.scoped(commit);
        return yield* gate.withPermits(WRITER_GATE_PERMITS)(Effect.uninterruptible(scopedCommit));
      }).pipe(
        Effect.mapError((failure) =>
          normalizeProviderUpdateFailure(failure, ambiguousInstances, input.providerInstanceId),
        ),
      ),
    (canonicalRequest) => Effect.sync(() => canonicalRequest.fill(ZERO)),
  );

const canonicalDeleteRequest = (input: DeleteProviderInstanceInput): Buffer =>
  Buffer.from(
    canonicalJson({
      expected_revision: input.expectedRevision,
      provider_instance_id: input.providerInstanceId,
    }),
    "utf8",
  );

const deleteOperationResult = (
  persistence: ProviderPersistence,
  input: DeleteProviderInstanceInput,
  canonicalRequest: Uint8Array,
): Effect.Effect<boolean, IdempotencyKeyReuseFailure | ProviderPersistenceFailure> =>
  persistence
    .readOperationResult({
      administratorUserId: input.administratorId,
      canonicalRequest,
      method: DELETE_PROVIDER_INSTANCE_METHOD,
      operationId: input.operationId,
    })
    .pipe(
      Effect.mapError((failure) =>
        failure._tag === "ProviderOperationKeyReused" ? new IdempotencyKeyReused({}) : failure,
      ),
      Effect.flatMap((serialized) => {
        if (serialized === undefined) {
          return Effect.succeed(false);
        }
        return Object.keys(serialized).length === ZERO
          ? Effect.succeed(true)
          : Effect.die(new Error("invalid durable provider delete result"));
      }),
    );

interface ProviderDeleteInput {
  readonly ambiguousInstances: Set<string>;
  readonly fenceActivities: InstanceActivityDeletionFenceAcquire;
  readonly fenceInstance: InstanceCutoverFence;
  readonly input: DeleteProviderInstanceInput;
  readonly persistence: ProviderPersistence;
}

interface ProviderDeleteCommitInput extends ProviderDeleteInput {
  readonly canonicalRequest: Uint8Array;
}

const recoverProviderDeleteCommit = (
  commit: ProviderDeleteCommitInput,
  activityFence: InstanceActivityDeletionFence,
): Effect.Effect<void, ProviderMutationFailure> => {
  const { ambiguousInstances, canonicalRequest, input, persistence } = commit;
  ambiguousInstances.add(input.providerInstanceId);
  const ambiguousFailure = Effect.fail(new ProviderCommitAmbiguous({}));
  return deleteOperationResult(persistence, input, canonicalRequest).pipe(
    Effect.flatMap((committed) => {
      if (committed) {
        return Effect.sync(() => {
          ambiguousInstances.delete(input.providerInstanceId);
        });
      }
      return persistence.loadInstanceRecord(input.providerInstanceId).pipe(
        Effect.flatMap((current) => {
          if (current === undefined) {
            return ambiguousFailure;
          }
          ambiguousInstances.delete(input.providerInstanceId);
          return activityFence.open.pipe(Effect.andThen(ambiguousFailure));
        }),
      );
    }),
    Effect.catchTag("ProviderPersistenceError", () => ambiguousFailure),
  );
};

const persistProviderDelete = (
  commit: ProviderDeleteCommitInput,
  activityFence: InstanceActivityDeletionFence,
): Effect.Effect<void, ProviderMutationFailure> => {
  const { ambiguousInstances, canonicalRequest, input, persistence } = commit;
  return persistence
    .deleteInstance({
      expectedRevision: input.expectedRevision,
      operation: {
        administratorUserId: input.administratorId,
        canonicalRequest,
        method: DELETE_PROVIDER_INSTANCE_METHOD,
        operationId: input.operationId,
        serializedResult: {},
      },
      providerInstanceId: input.providerInstanceId,
    })
    .pipe(
      Effect.catchTag("ProviderRevisionMismatch", () => Effect.fail(new RevisionMismatch({}))),
      Effect.catchTag("ProviderPersistenceError", () =>
        recoverProviderDeleteCommit(commit, activityFence),
      ),
      Effect.flatMap((deleted) => {
        if (deleted === true) {
          return Effect.void;
        }
        ambiguousInstances.add(input.providerInstanceId);
        return Effect.fail(new ProviderCommitAmbiguous({}));
      }),
    );
};

const commitProviderDelete = (
  commit: ProviderDeleteCommitInput,
): Effect.Effect<void, ProviderMutationFailure, Scope.Scope> =>
  Effect.gen(function* commitProviderDeleteEffect() {
    const {
      ambiguousInstances,
      canonicalRequest,
      fenceActivities,
      fenceInstance,
      input,
      persistence,
    } = commit;
    const replay = yield* deleteOperationResult(persistence, input, canonicalRequest);
    if (replay) {
      ambiguousInstances.delete(input.providerInstanceId);
      return yield* Effect.void;
    }
    const current = yield* expectedProviderInstance(persistence, input);
    if (current.enabled) {
      return yield* Effect.fail(new ProviderInstanceBusy({}));
    }
    ambiguousInstances.delete(input.providerInstanceId);
    const activityFence = yield* fenceActivities(input.providerInstanceId);
    const runtimeFence = fenceInstance(input.providerInstanceId, "retire-current").pipe(
      Effect.mapError(() => new ProviderPluginUnavailable({})),
      Effect.matchEffect({
        onFailure: (failure) => activityFence.open.pipe(Effect.andThen(Effect.fail(failure))),
        onSuccess: () => Effect.void,
      }),
    );
    yield* runtimeFence;
    return yield* persistProviderDelete(commit, activityFence).pipe(
      Effect.matchEffect({
        onFailure: (failure): Effect.Effect<never, ProviderMutationFailure> => {
          if (failure._tag === "ProviderCommitAmbiguous") {
            return Effect.fail(failure);
          }
          return activityFence.open.pipe(Effect.andThen(Effect.fail(failure)));
        },
        onSuccess: () => Effect.void,
      }),
    );
  });

const deleteProviderInstance = (
  deletion: ProviderDeleteInput,
  gate: Semaphore.Semaphore,
): Effect.Effect<void, ProviderMutationFailure> =>
  Effect.acquireUseRelease(
    Effect.sync(() => canonicalDeleteRequest(deletion.input)),
    (canonicalRequest) => {
      const commit = commitProviderDelete({ ...deletion, canonicalRequest });
      return gate.withPermits(WRITER_GATE_PERMITS)(Effect.uninterruptible(Effect.scoped(commit)));
    },
    (canonicalRequest) => Effect.sync(() => canonicalRequest.fill(ZERO)),
  );

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
  discover,
  fenceActivities,
  fenceInstance,
  masterKey,
  persistence,
  verifyCandidate,
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
    const providerStatuses = new Map<string, ProviderDiscoveryStatus>();
    const instanceGates = new Map<string, Semaphore.Semaphore>();
    const ambiguousInstances = new Set<string>();
    const instanceGate = (providerInstanceId: string): Semaphore.Semaphore => {
      const current = instanceGates.get(providerInstanceId);
      if (current !== undefined) {
        return current;
      }
      const created = Semaphore.makeUnsafe(WRITER_GATE_PERMITS);
      instanceGates.set(providerInstanceId, created);
      return created;
    };
    for (const provider of bundledProviders) {
      const status = yield* reconcileProvider(persistence, discover, provider);
      providerStatuses.set(provider.providerTypeId, status);
      yield* Effect.logInfo({
        event: "provider.discovery_completed",
        providerType: provider.providerTypeId,
        status,
      });
    }
    const candidateVerifier: CandidateVerification =
      verifyCandidate ??
      (() => Effect.die(new Error("provider candidate verifier is unavailable")));
    const activityFencer = fenceActivities ?? noProviderActivityFence;
    return Object.freeze({
      createProviderInstance: (input: CreateProviderInstanceInput) =>
        createProviderInstance(persistence, providerStatuses, candidateVerifier, input),
      deleteProviderInstance: (input: DeleteProviderInstanceInput) =>
        deleteProviderInstance(
          {
            ambiguousInstances,
            fenceActivities: activityFencer,
            fenceInstance,
            input,
            persistence,
          },
          instanceGate(input.providerInstanceId),
        ),
      getProviderInstance: (input: GetProviderInstanceInput) =>
        getProviderInstance(persistence, input),
      listProviderInstances: (input: ListProviderInstancesInput) =>
        listProviderInstances(persistence, pageTokens, input),
      listProviderTypes: (input: ListProviderTypesInput) =>
        listProviderTypes(persistence, pageTokens, input),
      updateProviderInstance: (input: UpdateProviderInstanceInput) =>
        updateProviderInstance(
          persistence,
          ambiguousInstances,
          providerStatuses,
          candidateVerifier,
          fenceInstance,
          instanceGate(input.providerInstanceId),
          input,
        ),
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
        discover: (provider) => discoverProvider(supervisor, provider),
        fenceActivities: noProviderActivityFence,
        fenceInstance: (providerInstanceId, mode) =>
          supervisor.fenceInstance(providerInstanceId, mode),
        masterKey: Redacted.value(config.security.masterKey),
        persistence: database.providers,
        verifyCandidate: (provider, configuration, credentials) =>
          verifyProviderCandidate(supervisor, provider, configuration, credentials),
      });
      return ProviderManagement.of(service);
    }),
  );
}

export { ProviderManagement, makeProviderManagement };
export type {
  CandidateVerification,
  CreateProviderInstanceInput,
  DeleteProviderInstanceInput,
  GetProviderInstanceInput,
  ListProviderInstancesInput,
  ListProviderInstancesResult,
  ListProviderTypesInput,
  ListProviderTypesResult,
  IdempotencyKeyReuseFailure,
  ProviderAuthenticationFailure,
  ProviderCommitAmbiguousFailure,
  ProviderCredentialsUnavailableFailure,
  ProviderInstanceBusyFailure,
  InstanceAdmissionFence,
  InstanceCutoverFence,
  InstanceActivityDeletionFence,
  InstanceActivityDeletionFenceAcquire,
  ProviderIncompatibleFailure,
  ProviderDiscovery,
  ProviderManagementDependencies,
  ProviderManagementService,
  ProviderMutationFailure,
  ProviderPluginUnavailableFailure,
  ProviderResourceNotFoundFailure,
  ProviderUnavailableFailure,
  ProviderUserChangedFailure,
  ProviderValidationFailure,
  RevisionMismatchFailure,
  UpdateProviderInstanceInput,
  VerifiedProviderCandidate,
};
