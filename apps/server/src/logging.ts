import { Cause, Effect, Layer, Logger, References } from "effect";
import type { LogLevel } from "effect";

import type { Config } from "./config.ts";

const MAXIMUM_STACK_FRAMES = 20;
const FIRST_INDEX = 0;
const SINGLE_MESSAGE_COUNT = 1;
const KNOWN_ERROR_TAGS: Readonly<Record<string, true>> = Object.freeze({
  ConfigParseError: true,
  ConfigReadError: true,
  ConfigValidationError: true,
  DatabaseConnectionError: true,
  MigrationError: true,
  ServerBindError: true,
  ShutdownError: true,
});
const MINIMUM_LEVEL: Readonly<Record<Config["Service"]["logging"]["level"], LogLevel.LogLevel>> =
  Object.freeze({
    debug: "Debug",
    error: "Error",
    fatal: "Fatal",
    info: "Info",
    trace: "Trace",
    warn: "Warn",
  });

type LineWriter = (line: string) => void;

interface EventMessage {
  readonly durationMs?: number;
  readonly errorTag?: string;
  readonly event: string;
  readonly sanitizedStackFrames?: readonly string[];
}

interface LogRecord {
  duration_ms?: number;
  error_tag?: string;
  event: string;
  level: string;
  sanitized_stack_frames?: readonly string[];
  timestamp: string;
}

const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line);
};

const stderrWriter: LineWriter = (line) => {
  process.stderr.write(line);
};

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

const addOptionalFields = (record: LogRecord, message: Readonly<EventMessage>): void => {
  if (message.durationMs !== undefined) {
    record.duration_ms = message.durationMs;
  }
  if (message.errorTag !== undefined) {
    record.error_tag = message.errorTag;
  }
  if (message.sanitizedStackFrames !== undefined) {
    record.sanitized_stack_frames = message.sanitizedStackFrames;
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
  addOptionalFields(record, eventMessage);
  return record;
};

const configuredLoggingLayer = (
  config: Readonly<Config["Service"]>,
  write: (line: string) => void = stdoutWriter,
) => {
  const jsonLogger = Logger.make<unknown, void>(
    ({ date, logLevel, message }: Logger.Options<unknown>) => {
      const record = recordFor(message, logLevel, date);
      if (record !== undefined) {
        write(`${JSON.stringify(record)}\n`);
      }
    },
  );
  return Layer.mergeAll(
    Logger.layer([jsonLogger]),
    Layer.succeed(References.MinimumLogLevel, MINIMUM_LEVEL[config.logging.level]),
  );
};

const logEvent = (event: string, fields: { readonly durationMs?: number } = {}) =>
  Effect.logInfo({ event, ...fields } satisfies EventMessage);

const logFailure = (
  cause: Readonly<Cause.Cause<unknown>>,
  event: "server.shutdown_failed" | "server.start_failed",
) => {
  const tag = errorTag(cause);
  const stackFrames = sanitizedStackFrames(cause);
  if (stackFrames === undefined) {
    return Effect.logFatal({ errorTag: tag, event } satisfies EventMessage);
  }
  return Effect.logFatal({
    errorTag: tag,
    event,
    sanitizedStackFrames: stackFrames,
  } satisfies EventMessage);
};

const writeBootstrapFailure = (
  cause: Readonly<Cause.Cause<unknown>>,
  write: (line: string) => void = stderrWriter,
): void => {
  write(
    `${JSON.stringify({
      error_tag: errorTag(cause),
      event: "server.start_failed",
      level: "fatal",
      timestamp: new Date().toISOString(),
    } satisfies LogRecord)}\n`,
  );
};

export { configuredLoggingLayer, logEvent, logFailure, writeBootstrapFailure };
