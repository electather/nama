import { create } from "@bufbuild/protobuf";
import type {
  JsonObject as ProtobufJsonObject,
  JsonValue as ProtobufJsonValue,
  MessageInitShape,
} from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import {
  ProviderConnectionStatus,
  ProviderConnectionTestSchema,
  TestProviderConfigurationResponseSchema,
  TestProviderInstanceResponseSchema,
} from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { ProviderService } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import type { JsonObject, JsonValue } from "../database/provider-schema.ts";
import type {
  ProviderConnectionTestResult,
  ProviderManagementService,
} from "../provider/provider-management.ts";
import { getRequestAdministrator } from "./request-pipeline.ts";
import type { RequestRuntime } from "./request-runtime.ts";

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

const internalJsonValue = (value: ProtobufJsonValue): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((item) => internalJsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return internalJsonObject(value);
};

const internalJsonObject = (value: ProtobufJsonObject): JsonObject => {
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = internalJsonValue(child);
  }
  return result;
};

const providerConnectionStatus = (
  status: ProviderConnectionTestResult["status"],
): ProviderConnectionStatus => {
  let mapped = ProviderConnectionStatus.INCOMPATIBLE;
  switch (status) {
    case "authentication_failed": {
      mapped = ProviderConnectionStatus.AUTHENTICATION_FAILED;
      break;
    }
    case "connected": {
      mapped = ProviderConnectionStatus.CONNECTED;
      break;
    }
    case "incompatible": {
      break;
    }
    case "unreachable": {
      mapped = ProviderConnectionStatus.UNREACHABLE;
      break;
    }
  }
  return mapped;
};

const providerConnectionMessage = (result: ProviderConnectionTestResult) => {
  const message: MessageInitShape<typeof ProviderConnectionTestSchema> = {
    capabilities: [...result.capabilities],
    status: providerConnectionStatus(result.status),
    summary: result.summary,
  };
  if (result.remoteName !== undefined) {
    message.remoteName = result.remoteName;
  }
  if (result.remoteVersion !== undefined) {
    message.remoteVersion = result.remoteVersion;
  }
  return create(ProviderConnectionTestSchema, message);
};

const createProviderConnectionServiceHandlers = ({
  providerManagement,
  requestRuntime,
}: Readonly<{
  readonly providerManagement: ProviderManagementService;
  readonly requestRuntime: RequestRuntime;
}>): Partial<ServiceImpl<typeof ProviderService>> => ({
  // fallow-ignore-next-line code-duplication -- Each generated route independently enforces request-local Administrator presence.
  testProviderConfiguration: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .testProviderConfiguration({
          configuration: internalJsonObject(request.configuration ?? {}),
          providerTypeId: request.providerTypeId,
        })
        .pipe(
          Effect.map((result) =>
            create(TestProviderConfigurationResponseSchema, {
              result: providerConnectionMessage(result),
            }),
          ),
        ),
      context.signal,
    );
  },
  // fallow-ignore-next-line code-duplication -- Each generated route independently enforces request-local Administrator presence.
  testProviderInstance: (request, context) => {
    const administrator = getRequestAdministrator(context.values);
    if (administrator === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(
      providerManagement
        .testProviderInstance({ providerInstanceId: request.providerInstanceId })
        .pipe(
          Effect.map((result) =>
            create(TestProviderInstanceResponseSchema, {
              result: providerConnectionMessage(result),
            }),
          ),
        ),
      context.signal,
    );
  },
});

export { createProviderConnectionServiceHandlers, internalJsonObject, protobufJsonObject };
