import { randomBytes } from "node:crypto";

import { Effect } from "effect";

import {
  LAUNCH_DOCUMENT_VERSION,
  MAXIMUM_LAUNCH_DOCUMENT_BYTES,
  PLUGIN_BEARER_BYTES,
} from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import type { PluginLaunch, PluginLaunchDescriptor, PreparedPluginLaunch } from "./model.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_STRING_LENGTH = 0;
const ARRAY_LENGTH_PROPERTY_COUNT = 1;
const JSON_OBJECT_OPENING_BRACE_LENGTH = "{".length;
const INVALID_PLUGIN_LAUNCH = Symbol("invalid-plugin-launch");

const JSON_OBJECT_CLOSING_BRACE_INDEX = -"}".length;

interface ProviderLaunchContext {
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly credentials: Readonly<Record<string, string>>;
}

const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (!isUnknownRecord(value) || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const keys = Object.keys(value).toSorted();
  return (
    Reflect.ownKeys(value).length === keys.length &&
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
};

const encodeJsonScalar = (value: boolean | number | string | null): string => JSON.stringify(value);
const encodeJsonNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    throw new TypeError("invalid JSON value");
  }
  return encodeJsonScalar(value);
};

const encodeDataProperty = (value: object, key: string, ancestors: Set<object>): string => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property === undefined || property.enumerable !== true || !("value" in property)) {
    throw new TypeError("invalid JSON value");
  }
  return encodeJsonValue(property.value, ancestors);
};

const encodeJsonArray = (value: readonly unknown[], ancestors: Set<object>): string => {
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    Reflect.ownKeys(value).length !== value.length + ARRAY_LENGTH_PROPERTY_COUNT ||
    !keys.every((key, index) => key === String(index)) ||
    ancestors.has(value)
  ) {
    throw new TypeError("invalid JSON value");
  }
  ancestors.add(value);
  const items = keys.map((key) => encodeDataProperty(value, key, ancestors));
  ancestors.delete(value);
  return `[${items.join(",")}]`;
};

const encodeJsonRecord = (
  value: Readonly<Record<string, unknown>>,
  ancestors: Set<object>,
): string => {
  const keys = Object.keys(value).toSorted();
  if (Reflect.ownKeys(value).length !== keys.length || ancestors.has(value)) {
    throw new TypeError("invalid JSON value");
  }
  ancestors.add(value);
  const fields = keys.map(
    (key) => `${JSON.stringify(key)}:${encodeDataProperty(value, key, ancestors)}`,
  );
  ancestors.delete(value);
  return `{${fields.join(",")}}`;
};

const encodeJsonValue = (value: unknown, ancestors: Set<object>): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return encodeJsonScalar(value);
  }
  if (typeof value === "number") {
    return encodeJsonNumber(value);
  }
  if (Array.isArray(value)) {
    return encodeJsonArray(value, ancestors);
  }
  if (isPlainRecord(value)) {
    return encodeJsonRecord(value, ancestors);
  }
  throw new TypeError("invalid JSON value");
};

const encodeCanonicalJson = (value: unknown): string | undefined => {
  try {
    return encodeJsonValue(value, new Set());
  } catch {
    return undefined;
  }
};

const hasValidCredentials = (
  credentials: Readonly<Record<string, unknown>>,
): credentials is Readonly<Record<string, string>> => {
  const keys = Object.keys(credentials);
  return (
    Reflect.ownKeys(credentials).length === keys.length &&
    keys.every((key) => {
      const property = Object.getOwnPropertyDescriptor(credentials, key);
      return (
        property !== undefined &&
        property.enumerable === true &&
        "value" in property &&
        typeof property.value === "string"
      );
    })
  );
};

const validProviderContext = (
  launch: Readonly<Record<string, unknown>>,
): launch is Readonly<Record<string, unknown>> & ProviderLaunchContext => {
  const { configuration, credentials } = launch;
  return (
    isPlainRecord(configuration) && isPlainRecord(credentials) && hasValidCredentials(credentials)
  );
};

const encodeLaunchContext = (context: Readonly<Record<string, unknown>>): string | undefined => {
  const documentContext = encodeCanonicalJson(context);
  if (
    documentContext === undefined ||
    Buffer.byteLength(documentContext, "utf8") > MAXIMUM_LAUNCH_DOCUMENT_BYTES
  ) {
    return undefined;
  }
  return documentContext;
};
const encodeProviderLaunchContext = (
  descriptor: PluginLaunchDescriptor,
  launch: ProviderLaunchContext,
  fields: Readonly<Record<string, unknown>>,
): string | undefined =>
  encodeLaunchContext({
    configuration: launch.configuration,
    credentials: launch.credentials,
    provider_type: descriptor.expectedProviderType,
    ...fields,
  });

const prepareDiscoveryLaunch = (
  launch: Readonly<Record<string, unknown>>,
): PreparedPluginLaunch | undefined => {
  if (!hasExactKeys(launch, ["kind"])) {
    return undefined;
  }
  const documentContext = encodeLaunchContext({ kind: "discovery" });
  if (documentContext === undefined) {
    return undefined;
  }
  return Object.freeze({ documentContext, kind: "discovery" });
};

const prepareCandidateLaunch = (
  descriptor: PluginLaunchDescriptor,
  launch: Readonly<Record<string, unknown>>,
): PreparedPluginLaunch | undefined => {
  if (
    !hasExactKeys(launch, ["configuration", "credentials", "kind"]) ||
    !validProviderContext(launch)
  ) {
    return undefined;
  }
  const documentContext = encodeProviderLaunchContext(descriptor, launch, {
    kind: "candidate",
  });
  if (documentContext === undefined) {
    return undefined;
  }
  return Object.freeze({ documentContext, kind: "candidate" });
};

const prepareInstanceLaunch = (
  descriptor: PluginLaunchDescriptor,
  launch: Readonly<Record<string, unknown>>,
): PreparedPluginLaunch | undefined => {
  const { providerInstanceId, revision } = launch;
  if (
    !hasExactKeys(launch, [
      "configuration",
      "credentials",
      "kind",
      "providerInstanceId",
      "revision",
    ]) ||
    !validProviderContext(launch) ||
    typeof providerInstanceId !== "string" ||
    providerInstanceId.length === EMPTY_STRING_LENGTH ||
    typeof revision !== "string" ||
    revision.length === EMPTY_STRING_LENGTH
  ) {
    return undefined;
  }
  const documentContext = encodeProviderLaunchContext(descriptor, launch, {
    kind: "instance",
    provider_instance_id: providerInstanceId,
    revision,
  });
  if (documentContext === undefined) {
    return undefined;
  }
  return Object.freeze({
    documentContext,
    kind: "instance",
    providerInstanceId,
    revision,
  });
};

const prepareKnownLaunch = (
  descriptor: PluginLaunchDescriptor,
  launch: Readonly<Record<string, unknown>>,
): PreparedPluginLaunch | undefined => {
  switch (launch["kind"]) {
    case "candidate": {
      return prepareCandidateLaunch(descriptor, launch);
    }
    case "discovery": {
      return prepareDiscoveryLaunch(launch);
    }
    case "instance": {
      return prepareInstanceLaunch(descriptor, launch);
    }
    default: {
      return undefined;
    }
  }
};

const preparePluginLaunch = (
  descriptor: PluginLaunchDescriptor,
  launch: PluginLaunch,
): Effect.Effect<PreparedPluginLaunch, PluginUnavailableFailure> =>
  Effect.try({
    catch: () => unavailable("launch_document_invalid"),
    try: () => {
      if (!isPlainRecord(launch)) {
        return INVALID_PLUGIN_LAUNCH;
      }
      return prepareKnownLaunch(descriptor, launch) ?? INVALID_PLUGIN_LAUNCH;
    },
  }).pipe(
    Effect.flatMap((prepared) => {
      if (prepared === INVALID_PLUGIN_LAUNCH) {
        return Effect.fail(unavailable("launch_document_invalid"));
      }
      return Effect.succeed(prepared);
    }),
  );
const makePluginLaunchDocument = (
  launch: PreparedPluginLaunch,
  socketPath: string,
): Effect.Effect<
  Readonly<{ readonly bearer: string; readonly document: string }>,
  PluginUnavailableFailure
> => {
  const bearer = randomBytes(PLUGIN_BEARER_BYTES).toString("base64url");
  const contextFields = launch.documentContext.slice(
    JSON_OBJECT_OPENING_BRACE_LENGTH,
    JSON_OBJECT_CLOSING_BRACE_INDEX,
  );
  const document =
    `{"bearer":${JSON.stringify(bearer)},${contextFields},` +
    `"socket_path":${JSON.stringify(socketPath)},"version":${LAUNCH_DOCUMENT_VERSION}}`;
  if (Buffer.byteLength(document, "utf8") > MAXIMUM_LAUNCH_DOCUMENT_BYTES) {
    return Effect.fail(unavailable("launch_document_invalid"));
  }
  return Effect.succeed({ bearer, document });
};

export { makePluginLaunchDocument, preparePluginLaunch };
