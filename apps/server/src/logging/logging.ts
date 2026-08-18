import type { Code } from "@connectrpc/connect";
import { Effect, Layer, Logger, References } from "effect";
import type { Cause, LogLevel } from "effect";

import type { Config } from "../config/config.ts";
import { errorTag, recordFor, sanitizedStackFrames } from "./record.ts";
import type { EventMessage, LogRecord } from "./record.ts";

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
  writeBootstrapFailure,
};
export type { RpcCompletionRecord };
