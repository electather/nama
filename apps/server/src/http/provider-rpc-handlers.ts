// oxlint-disable eslint/max-lines-per-function -- The thin generated-service mapping remains one complete provider-neutral route inventory.
import { create } from "@bufbuild/protobuf";
import type {
  JsonObject as ProtobufJsonObject,
  JsonValue as ProtobufJsonValue,
} from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import {
  CreateProviderInstanceResponseSchema,
  GetProviderInstanceResponseSchema,
  ListProviderInstancesResponseSchema,
  ListProviderTypesResponseSchema,
  ProviderInstanceStatus,
} from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { ProviderService } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { ProviderInstanceRecord } from "../database/provider-persistence.ts";
import type { JsonObject, JsonValue } from "../database/provider-schema.ts";
import type { ProviderManagementService } from "../provider/provider-management.ts";
import { getRequestAdministrator } from "./request-pipeline.ts";
import type { RequestRuntime } from "./request-runtime.ts";

type ProviderServiceHandlerDependencies = Readonly<{
  readonly providerManagement: ProviderManagementService;
  readonly requestRuntime: RequestRuntime;
}>;

const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
});

const isJsonArray = (value: JsonValue): value is readonly JsonValue[] => Array.isArray(value);

const protobufJsonValue = (value: JsonValue): ProtobufJsonValue => {
  if (isJsonArray(value)) {
    return value.map((item) => protobufJsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const result: ProtobufJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = protobufJsonValue(child);
  }
  return result;
};

// fallow-ignore-next-line code-duplication -- Explicit JSON conversion keeps generated and persistence value domains separate.
const protobufJsonObject = (value: JsonObject): ProtobufJsonObject => {
  const result: ProtobufJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = protobufJsonValue(child);
  }
  return result;
};
// fallow-ignore-next-line code-duplication -- Reverse conversion validates the generated JSON domain without a shared unsafe cast.
const internalJsonValue = (value: ProtobufJsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => internalJsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return internalJsonObject(value);
};

// fallow-ignore-next-line code-duplication -- Object conversion preserves recursive value validation at the handler boundary.
const internalJsonObject = (value: ProtobufJsonObject): JsonObject => {
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = internalJsonValue(child);
  }
  return result;
};

const providerInstanceStatus = (instance: ProviderInstanceRecord): ProviderInstanceStatus => {
  if (!instance.enabled) {
    return ProviderInstanceStatus.DISABLED;
  }
  if (!instance.credentialsAvailable || instance.observation.status === "unavailable") {
    return ProviderInstanceStatus.UNAVAILABLE;
  }
  if (instance.observation.status === "authentication_failed") {
    return ProviderInstanceStatus.AUTHENTICATION_FAILED;
  }
  return ProviderInstanceStatus.HEALTHY;
};

const providerInstanceMessage = (instance: ProviderInstanceRecord) => ({
  configuration: protobufJsonObject(instance.configuration),
  configuredSecrets: instance.configuredSecretKeys.map((key) => ({ configured: true, key })),
  createdAt: timestampFromDate(instance.createdAt),
  displayName: instance.displayName,
  enabled: instance.enabled,
  id: instance.id,
  providerTypeId: instance.providerTypeId,
  revision: instance.revision,
  status: providerInstanceStatus(instance),
  syncPriority: instance.syncPriority,
  updatedAt: timestampFromDate(instance.updatedAt),
});

const createProviderServiceHandlers = ({
  providerManagement,
  requestRuntime,
}: ProviderServiceHandlerDependencies): Partial<ServiceImpl<typeof ProviderService>> => ({
  // fallow-ignore-next-line code-duplication -- Every generated route independently enforces request-local Administrator presence.
  createProviderInstance: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .createProviderInstance({
          administratorId: administrator.id,
          configuration: internalJsonObject(request.configuration ?? {}),
          displayName: request.displayName,
          enabled: request.enabled,
          operationId: request.operationId,
          providerTypeId: request.providerTypeId,
          // oxlint-disable-next-line eslint/no-ternary -- Omitting an unspecified sync priority preserves the management input contract.
          ...(request.syncPriority === undefined ? {} : { syncPriority: request.syncPriority }),
        })
        .pipe(
          Effect.map((providerInstance) =>
            create(CreateProviderInstanceResponseSchema, {
              providerInstance: providerInstanceMessage(providerInstance),
            }),
          ),
        ),
      context.signal,
    );
  },
  // fallow-ignore-next-line code-duplication -- Every generated route independently enforces request-local Administrator presence.
  getProviderInstance: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .getProviderInstance({ providerInstanceId: request.providerInstanceId })
        .pipe(
          Effect.map((providerInstance) =>
            create(GetProviderInstanceResponseSchema, {
              providerInstance: providerInstanceMessage(providerInstance),
            }),
          ),
        ),
      context.signal,
    );
  },
  // fallow-ignore-next-line code-duplication -- Instance and type list routes intentionally retain distinct response projections.
  listProviderInstances: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .listProviderInstances({
          administratorId: administrator.id,
          pageSize: request.pageSize,
          pageToken: request.pageToken,
        })
        .pipe(
          Effect.map(({ nextPageToken, providerInstances }) =>
            create(ListProviderInstancesResponseSchema, {
              nextPageToken,
              providerInstances: providerInstances.map((instance) =>
                providerInstanceMessage(instance),
              ),
            }),
          ),
        ),
      context.signal,
    );
  },
  // fallow-ignore-next-line code-duplication -- Instance and type list routes intentionally retain distinct response projections.
  listProviderTypes: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .listProviderTypes({
          administratorId: administrator.id,
          pageSize: request.pageSize,
          pageToken: request.pageToken,
        })
        .pipe(
          Effect.map(({ nextPageToken, providerTypes }) =>
            create(ListProviderTypesResponseSchema, {
              nextPageToken,
              providerTypes: providerTypes.map((providerType) => ({
                capabilities: [...providerType.capabilities],
                configurationSchema: protobufJsonObject(providerType.configurationSchema),
                description: providerType.description,
                displayName: providerType.displayName,
                id: providerType.providerTypeId,
                schemaProfileVersion: providerType.schemaProfileVersion,
                schemaRevision: providerType.schemaRevision,
              })),
            }),
          ),
        ),
      context.signal,
    );
  },
});

export { createProviderServiceHandlers };
export type { ProviderServiceHandlerDependencies };
