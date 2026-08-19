import { create } from "@bufbuild/protobuf";
import type {
  JsonObject as ProtobufJsonObject,
  JsonValue as ProtobufJsonValue,
} from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import { ListProviderTypesResponseSchema } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { ProviderService } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
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

const protobufJsonObject = (value: JsonObject): ProtobufJsonObject => {
  const result: ProtobufJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = protobufJsonValue(child);
  }
  return result;
};

const createProviderServiceHandlers = ({
  providerManagement,
  requestRuntime,
}: ProviderServiceHandlerDependencies): Partial<ServiceImpl<typeof ProviderService>> => ({
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
