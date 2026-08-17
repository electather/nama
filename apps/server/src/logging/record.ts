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
  ServerBindError: true,
  ShutdownError: true,
});

interface EventMessage {
  readonly code?: number;
  readonly durationMs?: number;
  readonly errorTag?: string;
  readonly event: string;
  readonly method?: string;
  readonly requestId?: string;
  readonly sanitizedStackFrames?: readonly string[];
}

interface LogRecord {
  connect_code?: number;
  duration_ms?: number;
  error_tag?: string;
  event: string;
  level: string;
  request_id?: string;
  rpc_method?: string;
  sanitized_stack_frames?: readonly string[];
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
const addEventFields = (record: LogRecord, eventMessage: EventMessage): void => {
  if (eventMessage.event === "rpc.completed") {
    addOptionalField(record, "request_id", eventMessage.requestId);
    addOptionalField(record, "rpc_method", eventMessage.method);
    addOptionalField(record, "connect_code", eventMessage.code);
  } else {
    addOptionalField(record, "error_tag", eventMessage.errorTag);
    addOptionalField(record, "sanitized_stack_frames", eventMessage.sanitizedStackFrames);
  }
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
