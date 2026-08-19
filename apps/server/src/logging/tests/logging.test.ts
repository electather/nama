import { expect, it } from "@effect/vitest";
import { Cause, Effect, Redacted } from "effect";

import { Config } from "../../config/config.ts";
import { configuredLoggingLayer, logEvent, logFailure, writeBootstrapFailure } from "../logging.ts";

const config = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("postgres://secret") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("master-secret") }),
  server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://127.0.0.1:8080/" }),
});
const EXPECTED_RECORD_COUNT = 2;
const READY_RECORD_INDEX = 0;
const FAILURE_RECORD_INDEX = 1;
const SINGLE_RECORD_COUNT = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordFromLine = (line: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new TypeError("expected a structured log record");
  }
  return value;
};

const expectStableRecords = (lines: readonly string[]): void => {
  expect(lines).toHaveLength(EXPECTED_RECORD_COUNT);
  expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
  const records = lines.map((line) => recordFromLine(line));
  expect(typeof records[READY_RECORD_INDEX]?.["timestamp"]).toBe("string");
  expect(records[READY_RECORD_INDEX]).toEqual({
    duration_ms: 12,
    event: "server.ready",
    level: "info",
    timestamp: records[READY_RECORD_INDEX]?.["timestamp"],
  });
  expect(typeof records[FAILURE_RECORD_INDEX]?.["timestamp"]).toBe("string");
  expect(records[FAILURE_RECORD_INDEX]).toEqual({
    error_tag: "ConfigReadError",
    event: "server.start_failed",
    level: "fatal",
    timestamp: records[FAILURE_RECORD_INDEX]?.["timestamp"],
  });
};

const expectSafeFailures = (lines: readonly string[]): void => {
  expect(lines).toHaveLength(EXPECTED_RECORD_COUNT);
  expect(lines[READY_RECORD_INDEX]).toContain('"error_tag":"UnexpectedError"');
  expect(lines[READY_RECORD_INDEX]).not.toContain("sanitized_stack_frames");
  expect(lines[FAILURE_RECORD_INDEX]).toContain("sanitized_stack_frames");
  expect(lines.join("")).not.toContain("do-not-serialize-message");
  expect(lines.join("")).not.toContain("postgres://do-not-serialize-field");
};

it.effect("writes newline-delimited JSON with only stable fields and configured filtering", () =>
  Effect.gen(function* loggingTest() {
    const lines: string[] = [];
    const program = Effect.gen(function* loggingProgram() {
      yield* Effect.logDebug("ignored.debug.event");
      yield* logEvent("server.ready", { durationMs: 12 });
      yield* logFailure(Cause.fail({ _tag: "ConfigReadError" }), "server.start_failed");
    });
    const loggingLayer = configuredLoggingLayer(config, (line) => {
      lines.push(line);
    });
    yield* program.pipe(Effect.provide(loggingLayer));

    expectStableRecords(lines);
  }),
);

it.effect("keeps bootstrap and unexpected failures free of exception data", () =>
  Effect.gen(function* failureLoggingTest() {
    const lines: string[] = [];
    const defect = Object.assign(new Error("do-not-serialize-message"), {
      databaseUrl: "postgres://do-not-serialize-field",
    });
    writeBootstrapFailure(Cause.die(defect), (line) => {
      lines.push(line);
    });
    const failure = logFailure(Cause.die(defect), "server.start_failed");
    const loggingLayer = configuredLoggingLayer(config, (line) => {
      lines.push(line);
    });
    yield* failure.pipe(Effect.provide(loggingLayer));

    expectSafeFailures(lines);
  }),
);

it.effect("preserves bootstrap initialization as a stable failure tag", () =>
  Effect.gen(function* bootstrapFailureTagTest() {
    const lines: string[] = [];
    const failure = logFailure(
      Cause.fail({ _tag: "BootstrapTokenInitializationError" }),
      "server.start_failed",
    );
    const loggingLayer = configuredLoggingLayer(config, (line) => {
      lines.push(line);
    });

    yield* failure.pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    const record = recordFromLine(lines[READY_RECORD_INDEX] ?? "");
    expect(record).toEqual({
      error_tag: "BootstrapTokenInitializationError",
      event: "server.start_failed",
      level: "fatal",
      timestamp: record["timestamp"],
    });
  }),
);

it.effect("records only the safe provider discovery identity and status", () =>
  Effect.gen(function* providerDiscoveryLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(config, (line) => {
      lines.push(line);
    });
    yield* Effect.logInfo({
      event: "provider.discovery_completed",
      providerType: "jellyfin",
      status: "incompatible",
    }).pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    const record = recordFromLine(lines[READY_RECORD_INDEX] ?? "");
    expect(record).toEqual({
      event: "provider.discovery_completed",
      level: "info",
      provider_type: "jellyfin",
      status: "incompatible",
      timestamp: record["timestamp"],
    });
  }),
);

it.effect("drops unrecognized provider discovery status values", () =>
  Effect.gen(function* unsafeProviderStatusLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(config, (line) => {
      lines.push(line);
    });
    yield* Effect.logInfo({
      event: "provider.discovery_completed",
      providerType: "jellyfin",
      status: "api-key-sentinel",
    }).pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    const record = recordFromLine(lines[READY_RECORD_INDEX] ?? "");
    expect(record).not.toHaveProperty("status");
    expect(lines.join("")).not.toContain("api-key-sentinel");
  }),
);
