// oxlint-disable eslint/max-lines-per-function -- The thin generated-service mapping remains one complete provider-neutral route inventory.
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import {
  CreateProviderInstanceResponseSchema,
  DeleteProviderInstanceResponseSchema,
  GetProviderInstanceResponseSchema,
  ListProviderInstancesResponseSchema,
  ListProviderTypesResponseSchema,
  ProviderInstanceStatus,
  UpdateProviderInstanceResponseSchema,
} from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type {
  ProviderService,
  UpdateProviderInstanceRequest,
} from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { ProviderInstanceRecord } from "../database/provider-persistence.ts";
import type { ProviderManagementService } from "../provider/provider-management.ts";
import {
  createProviderConnectionServiceHandlers,
  internalJsonObject,
  protobufJsonObject,
} from "./provider-connection-rpc-handlers.ts";
import { getRequestAdministrator } from "./request-pipeline.ts";
import type { RequestRuntime } from "./request-runtime.ts";

type ProviderServiceHandlerDependencies = Readonly<{
  readonly providerManagement: ProviderManagementService;
  readonly requestRuntime: RequestRuntime;
}>;

const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
});

const optionalProviderUpdateInput = (
  request: UpdateProviderInstanceRequest,
): Readonly<{ displayName?: string; enabled?: boolean; syncPriority?: number }> => {
  const optionalInput: { displayName?: string; enabled?: boolean; syncPriority?: number } = {};
  if (request.displayName !== undefined) {
    optionalInput.displayName = request.displayName;
  }
  if (request.enabled !== undefined) {
    optionalInput.enabled = request.enabled;
  }
  if (request.syncPriority !== undefined) {
    optionalInput.syncPriority = request.syncPriority;
  }
  return optionalInput;
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
  ...createProviderConnectionServiceHandlers({ providerManagement, requestRuntime }),
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
  deleteProviderInstance: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    const response = create(DeleteProviderInstanceResponseSchema);
    return requestRuntime.runPromise(
      providerManagement
        .deleteProviderInstance({
          administratorId: administrator.id,
          expectedRevision: request.expectedRevision,
          operationId: request.operationId,
          providerInstanceId: request.providerInstanceId,
        })
        .pipe(Effect.as(response)),
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
  // fallow-ignore-next-line code-duplication -- Every generated route independently enforces request-local Administrator presence.
  updateProviderInstance: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    const optionalInput = optionalProviderUpdateInput(request);
    return requestRuntime.runPromise(
      providerManagement
        .updateProviderInstance({
          ...optionalInput,
          administratorId: administrator.id,
          clearConfigurationFields: [...request.clearConfigurationFields],
          configurationPatch: internalJsonObject(request.configurationPatch ?? {}),
          expectedRevision: request.expectedRevision,
          operationId: request.operationId,
          providerInstanceId: request.providerInstanceId,
        })
        .pipe(
          Effect.map((providerInstance) =>
            create(UpdateProviderInstanceResponseSchema, {
              providerInstance: providerInstanceMessage(providerInstance),
            }),
          ),
        ),
      context.signal,
    );
  },
});

export { createProviderServiceHandlers };
export type { ProviderServiceHandlerDependencies };
