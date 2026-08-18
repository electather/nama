// oxlint-disable eslint/max-statements, eslint/no-ternary, eslint/no-magic-numbers, typescript/consistent-return, unicorn/switch-case-braces -- Plugin log normalization is an allowlisted boundary with deliberate field branches.
import type { Code } from "@connectrpc/connect";
import { Effect, Layer, Logger, References } from "effect";
import type { Cause, LogLevel } from "effect";

import type { Config } from "../config/config.ts";
import { errorTag, recordFor, sanitizedStackFrames } from "./record.ts";
import type { EventMessage, LogRecord, PluginFieldValue } from "./record.ts";

const MINIMUM_LEVEL: Readonly<Record<Config["Service"]["logging"]["level"], LogLevel.LogLevel>> =
  Object.freeze({
    debug: "Debug",
    error: "Error",
    fatal: "Fatal",
    info: "Info",
    trace: "Trace",
    warn: "Warn",
  });

const RPC_SUCCESS_CODE = 0;
const BOOTSTRAP_FAILURE_LOG_LEVEL = "fatal";

type LineWriter = (line: string) => void;

type RpcCompletionRecord = Readonly<{
  event: "rpc.completed";
  requestId: string;
  method: string;
  code: Code | typeof RPC_SUCCESS_CODE;
  durationMs: number;
}>;

const stdoutWriter: LineWriter = (line) => {
  process.stdout.write(line);
};

const stderrWriter: LineWriter = (line) => {
  process.stderr.write(line);
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
const logFatalEvent = (event: string, fields: { readonly durationMs?: number } = {}) =>
  Effect.logFatal({ event, ...fields } satisfies EventMessage);
const logRpcCompletion = (record: RpcCompletionRecord): Effect.Effect<void> =>
  Effect.logInfo(record);

type PluginEventLevel = "debug" | "info" | "warn" | "error";

// fallow-ignore-next-line complexity -- Plugin logs normalize reserved lifecycle fields and bounded child fields in one allowlist.
const logPluginEvent = (
  level: PluginEventLevel,
  event: string,
  fields: Readonly<Record<string, PluginFieldValue>> = {},
): Effect.Effect<void> => {
  const pluginFields: Record<string, PluginFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      key !== "exitCode" &&
      key !== "providerInstanceId" &&
      key !== "providerTypeId" &&
      key !== "recoveryAttempt" &&
      key !== "signal"
    ) {
      pluginFields[key] = value;
    }
  }
  const exitCode = typeof fields["exitCode"] === "number" ? fields["exitCode"] : undefined;
  const providerInstanceId =
    typeof fields["providerInstanceId"] === "string" ? fields["providerInstanceId"] : undefined;
  const providerTypeId =
    typeof fields["providerTypeId"] === "string" ? fields["providerTypeId"] : undefined;
  const recoveryAttempt =
    typeof fields["recoveryAttempt"] === "number" ? fields["recoveryAttempt"] : undefined;
  const signal = typeof fields["signal"] === "string" ? fields["signal"] : undefined;
  const message: EventMessage = {
    event,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(Object.keys(pluginFields).length === 0 ? {} : { pluginFields }),
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(providerTypeId === undefined ? {} : { providerTypeId }),
    ...(recoveryAttempt === undefined ? {} : { recoveryAttempt }),
    ...(signal === undefined ? {} : { signal }),
  };
  switch (level) {
    case "debug":
      return Effect.logDebug(message);
    case "info":
      return Effect.logInfo(message);
    case "warn":
      return Effect.logWarning(message);
    case "error":
      return Effect.logError(message);
  }
};

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
      level: BOOTSTRAP_FAILURE_LOG_LEVEL,
      timestamp: new Date().toISOString(),
    } satisfies LogRecord)}\n`,
  );
};

export {
  configuredLoggingLayer,
  logEvent,
  logFailure,
  logFatalEvent,
  logRpcCompletion,
  logPluginEvent,
  writeBootstrapFailure,
};
export type { PluginEventLevel, RpcCompletionRecord };
