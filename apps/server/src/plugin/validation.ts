import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Effect } from "effect";

import {
  RESERVED_PLUGIN_LOG_FIELDS,
  SAFE_PLUGIN_ENUM_VALUE,
  SAFE_PLUGIN_IDENTIFIER,
  UNSAFE_EXECUTABLE_MODE,
} from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import type { PluginLaunchDescriptor } from "./model.ts";
import { isUnknownRecord } from "./value.ts";

const NUMBER_FIELD_KEY_COUNT = 1;
const ENUM_FIELD_KEY_COUNT = 2;

const EMPTY_STRING_LENGTH = 0;
const ROOT_USER_ID = 0;
const NO_MODE_BITS = 0;

const isUnknownArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const isValidEnumValues = (value: unknown): boolean =>
  isUnknownArray(value) &&
  value.length > NO_MODE_BITS &&
  value.every(
    (candidate, index, values) =>
      typeof candidate === "string" &&
      SAFE_PLUGIN_ENUM_VALUE.test(candidate) &&
      values.indexOf(candidate) === index,
  );

const isValidStderrField = (fieldName: string, field: unknown): boolean => {
  if (
    !SAFE_PLUGIN_IDENTIFIER.test(fieldName) ||
    RESERVED_PLUGIN_LOG_FIELDS[fieldName] === true ||
    !isUnknownRecord(field)
  ) {
    return false;
  }
  const { kind } = field;
  if (kind === "number") {
    return Object.keys(field).length === NUMBER_FIELD_KEY_COUNT;
  }
  return (
    kind === "enum" &&
    Object.keys(field).length === ENUM_FIELD_KEY_COUNT &&
    isValidEnumValues(field["values"])
  );
};

const isValidStderrEvent = (value: unknown, eventNames: Set<string>): boolean => {
  if (!isUnknownRecord(value)) {
    return false;
  }
  const { event, fields } = value;
  if (
    typeof event !== "string" ||
    !SAFE_PLUGIN_IDENTIFIER.test(event) ||
    eventNames.has(event) ||
    !isUnknownRecord(fields) ||
    !Object.entries(fields).every(([fieldName, field]) => isValidStderrField(fieldName, field))
  ) {
    return false;
  }
  eventNames.add(event);
  return true;
};

const hasValidLaunchArguments = (argumentsValue: readonly unknown[]): boolean =>
  argumentsValue.every((argument) => typeof argument === "string" && !argument.includes("\0"));

const isOpaqueProviderIdentifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > EMPTY_STRING_LENGTH;

const hasValidProviderIdentity = (descriptor: PluginLaunchDescriptor): boolean =>
  isOpaqueProviderIdentifier(descriptor.expectedProviderType);

const hasValidStderrEvents = (stderrEvents: readonly unknown[]): boolean => {
  const eventNames = new Set<string>();
  return stderrEvents.every((event) => isValidStderrEvent(event, eventNames));
};

const isValidDescriptor = (descriptor: PluginLaunchDescriptor): boolean => {
  if (!isUnknownArray(descriptor.arguments) || !isUnknownArray(descriptor.stderrEvents)) {
    return false;
  }
  return (
    hasValidLaunchArguments(descriptor.arguments) &&
    hasValidProviderIdentity(descriptor) &&
    hasValidStderrEvents(descriptor.stderrEvents)
  );
};

const validateExecutable = (
  executable: string,
  effectiveUserId: number | undefined,
): Effect.Effect<void, PluginUnavailableFailure> => {
  if (!isAbsolute(executable)) {
    return Effect.fail(unavailable("executable_invalid"));
  }
  return Effect.tryPromise({
    catch: () => unavailable("executable_invalid"),
    try: async () => {
      const executableStat = await lstat(executable);
      const validOwner =
        executableStat.uid === ROOT_USER_ID ||
        (effectiveUserId !== undefined && executableStat.uid === effectiveUserId);
      const unsafeMode = (executableStat.mode & UNSAFE_EXECUTABLE_MODE) !== NO_MODE_BITS;
      if (
        !executableStat.isFile() ||
        executableStat.isSymbolicLink() ||
        !validOwner ||
        unsafeMode
      ) {
        throw new Error("invalid executable");
      }
      await access(executable, constants.X_OK);
    },
  });
};

const validatePluginDescriptor = (
  descriptor: PluginLaunchDescriptor,
  effectiveUserId: number | undefined,
): Effect.Effect<PluginLaunchDescriptor, PluginUnavailableFailure> => {
  if (!isValidDescriptor(descriptor)) {
    return Effect.fail(unavailable("descriptor_invalid"));
  }
  return validateExecutable(descriptor.executable, effectiveUserId).pipe(Effect.as(descriptor));
};

export { validateExecutable, validatePluginDescriptor };
