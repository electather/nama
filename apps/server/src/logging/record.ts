import { Cause } from "effect";
import type { LogLevel } from "effect";

const MAXIMUM_STACK_FRAMES = 20;
const FIRST_INDEX = 0;
const SINGLE_MESSAGE_COUNT = 1;
const KNOWN_ERROR_TAGS: Readonly<Record<string, true>> = Object.freeze({
  BootstrapTokenInitializationError: true,
  ConfigParseError: true,
  ConfigReadError: true,
  ConfigValidationError: true,
  DatabaseConnectionError: true,
  DatabaseIntegrityError: true,
  MigrationError: true,
  PluginSupervisorBoundaryError: true,
  PluginSupervisorCleanupError: true,
  ServerBindError: true,
  ShutdownError: true,
});

interface EventMessage {
  readonly code?: number;
  readonly durationMs?: number;
  readonly errorTag?: string;
  readonly event: string;
  readonly exitCode?: number;
  readonly method?: string;
  readonly pluginFields?: Readonly<Record<string, number | string>>;
  readonly providerInstanceId?: string;
  readonly providerType?: string;
  readonly recoveryAttempt?: number;
  readonly requestId?: string;
  readonly sanitizedStackFrames?: readonly string[];
  readonly signal?: string;
}

interface LogRecord {
  [key: string]: number | readonly string[] | string | undefined;
  connect_code?: number;
  duration_ms?: number;
  error_tag?: string;
  event: string;
  exit_code?: number;
  level: string;
  provider_instance_id?: string;
  provider_type?: string;
  recovery_attempt?: number;
  request_id?: string;
  rpc_method?: string;
  sanitized_stack_frames?: readonly string[];
  signal?: string;
  timestamp: string;
}

const taggedValue = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || !("_tag" in value)) {
    return undefined;
  }
  const tag = value["_tag"];
  if (typeof tag !== "string" || KNOWN_ERROR_TAGS[tag] !== true) {
    return undefined;
  }
  return tag;
};

const failureValue = (cause: Readonly<Cause.Cause<unknown>>): unknown => {
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) {
      return reason.error;
    }
    if (Cause.isDieReason(reason)) {
      return reason.defect;
    }
  }
  return undefined;
};

const errorTag = (cause: Readonly<Cause.Cause<unknown>>): string =>
  taggedValue(failureValue(cause)) ?? "UnexpectedError";

const sanitizedStackFrames = (
  cause: Readonly<Cause.Cause<unknown>>,
): readonly string[] | undefined => {
  const value = failureValue(cause);
  if (taggedValue(value) !== undefined || !(value instanceof Error) || value.stack === undefined) {
    return undefined;
  }
  const frames = value.stack
    .split("\n")
    .slice(SINGLE_MESSAGE_COUNT)
    .filter((line) => line.trimStart().startsWith("at "))
    .slice(FIRST_INDEX, MAXIMUM_STACK_FRAMES);
  if (frames.length === FIRST_INDEX) {
    return undefined;
  }
  return frames;
};

const isEventMessage = (message: unknown): message is EventMessage =>
  typeof message === "object" &&
  message !== null &&
  "event" in message &&
  typeof message.event === "string";

const firstMessage = (message: unknown): unknown => {
  if (Array.isArray(message) && message.length === SINGLE_MESSAGE_COUNT) {
    return message[FIRST_INDEX];
  }
  return message;
};

const toEventMessage = (value: unknown): EventMessage | undefined => {
  if (typeof value === "string") {
    return { event: value };
  }
  if (isEventMessage(value)) {
    return value;
  }
  return undefined;
};

const addOptionalField = <Key extends keyof LogRecord>(
  record: LogRecord,
  key: Key,
  value: LogRecord[Key] | undefined,
): void => {
  if (value !== undefined) {
    record[key] = value;
  }
};
const addPluginFields = (record: LogRecord, eventMessage: EventMessage): void => {
  if (eventMessage.pluginFields === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(eventMessage.pluginFields)) {
    record[key] = value;
  }
};

const addFailureEventFields = (record: LogRecord, eventMessage: EventMessage): void => {
  addOptionalField(record, "error_tag", eventMessage.errorTag);
  addOptionalField(record, "exit_code", eventMessage.exitCode);
  addOptionalField(record, "provider_instance_id", eventMessage.providerInstanceId);
  addOptionalField(record, "provider_type", eventMessage.providerType);
  addOptionalField(record, "recovery_attempt", eventMessage.recoveryAttempt);
  addOptionalField(record, "sanitized_stack_frames", eventMessage.sanitizedStackFrames);
  addOptionalField(record, "signal", eventMessage.signal);
  addPluginFields(record, eventMessage);
};

const addEventFields = (record: LogRecord, eventMessage: EventMessage): void => {
  if (eventMessage.event === "rpc.completed") {
    addOptionalField(record, "request_id", eventMessage.requestId);
    addOptionalField(record, "rpc_method", eventMessage.method);
    addOptionalField(record, "connect_code", eventMessage.code);
    return;
  }
  addFailureEventFields(record, eventMessage);
};

const recordFor = (
  message: unknown,
  level: LogLevel.LogLevel,
  timestamp: Readonly<Date>,
): LogRecord | undefined => {
  const eventMessage = toEventMessage(firstMessage(message));
  if (eventMessage === undefined) {
    return undefined;
  }

  const record: LogRecord = {
    event: eventMessage.event,
    level: level.toLowerCase(),
    timestamp: timestamp.toISOString(),
  };
  addOptionalField(record, "duration_ms", eventMessage.durationMs);
  addEventFields(record, eventMessage);
  return record;
};

export { errorTag, recordFor, sanitizedStackFrames };
export type { EventMessage, LogRecord };
