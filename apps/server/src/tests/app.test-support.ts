import { expect } from "@effect/vitest";
import { Effect, Exit } from "effect";

import type { RunConfiguredOptions } from "../app.ts";
import { BootstrapToken } from "../setup/bootstrap-token.ts";
import type { BootstrapTokenService } from "../setup/bootstrap-token.ts";

const FIRST_RECORD_INDEX = 0;
const SINGLE_RECORD_COUNT = 1;
const FATAL_RUNTIME_FAILURE_COUNT = 1;
const RUNTIME_FAILURE = Object.freeze({ _tag: "RuntimeFailure" as const });

type ServerRuntimeLayer = NonNullable<RunConfiguredOptions["serverRuntimeLayer"]>;
type LifecycleCallback = () => void;
type LogRecord = Readonly<Record<string, unknown>>;

interface BootstrapActivationFailureFixture {
  readonly runtimeLayer: ServerRuntimeLayer;
  readonly wasMarkedReady: () => boolean;
  readonly wasReleased: () => boolean;
}

interface FatalRuntimeState {
  fatalReported: boolean;
  markedReady: boolean;
  ready: boolean;
  released: boolean;
}

interface FatalRuntimeFixture {
  readonly runtimeLayer: ServerRuntimeLayer;
  readonly wasFatalReported: () => boolean;
  readonly wasMarkedReady: () => boolean;
  readonly wasReleased: () => boolean;
}

const makeRecordedBootstrapToken = (
  bootstrapToken: BootstrapTokenService,
  onActivation: LifecycleCallback,
) => {
  const recordActivation = Effect.sync(onActivation);
  const activate = recordActivation.pipe(Effect.andThen(bootstrapToken.activate));
  return BootstrapToken.of({ ...bootstrapToken, activate });
};

const makeMarkReadyWithFatalReport = (
  state: FatalRuntimeState,
  reportFatalFailure: (cause: unknown) => Effect.Effect<boolean>,
) => {
  const markReady = Effect.sync(() => {
    state.markedReady = true;
    state.ready = true;
  });
  const reportFatal = reportFatalFailure(RUNTIME_FAILURE);
  return markReady.pipe(Effect.andThen(reportFatal), Effect.asVoid);
};

const isLogRecord = (value: unknown): value is LogRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const logRecordFromLine = (line: string): LogRecord => {
  const parsed: unknown = JSON.parse(line);
  if (!isLogRecord(parsed)) {
    throw new TypeError("expected a structured log record");
  }
  return parsed;
};

const eventNameFromLogLine = (line: string): string | undefined => {
  const { event } = logRecordFromLine(line);
  if (typeof event !== "string") {
    return undefined;
  }
  return event;
};
const expectLifecycleFailure = (
  exit: Exit.Exit<unknown, unknown>,
  fixture: {
    readonly wasMarkedReady: () => boolean;
    readonly wasReleased: () => boolean;
  },
  expectedReady: boolean,
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  expect(fixture.wasMarkedReady()).toBe(expectedReady);
  expect(fixture.wasReleased()).toBe(true);
};

const expectBootstrapActivationFailure = (
  exit: Exit.Exit<unknown, unknown>,
  fixture: BootstrapActivationFailureFixture,
  lines: readonly string[],
): void => {
  expectLifecycleFailure(exit, fixture, false);
  expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
  expect(logRecordFromLine(lines[FIRST_RECORD_INDEX] ?? "")).toMatchObject({
    error_tag: "BootstrapTokenInitializationError",
    event: "server.start_failed",
  });
};

const expectLifecycleOrder = (
  exit: Exit.Exit<unknown, unknown>,
  events: readonly string[],
): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  expect(events).toEqual([
    "listener.bound",
    "bootstrap.activated",
    "runtime.ready",
    "lan.started",
    "listener.released",
  ]);
};

const expectFatalRuntimeFailure = (
  exit: Exit.Exit<unknown, unknown>,
  fixture: FatalRuntimeFixture,
  lines: readonly string[],
): void => {
  expectLifecycleFailure(exit, fixture, true);
  expect(fixture.wasFatalReported()).toBe(true);
  const runtimeFailures = lines
    .map((line) => logRecordFromLine(line))
    .filter(({ event }) => event === "server.runtime_failed");
  expect(runtimeFailures).toHaveLength(FATAL_RUNTIME_FAILURE_COUNT);
  expect(runtimeFailures[FIRST_RECORD_INDEX]).toMatchObject({
    event: "server.runtime_failed",
    level: "fatal",
  });
  const eventNames = lines.map((line) => eventNameFromLogLine(line));
  expect(eventNames).not.toContain("server.start_failed");
  expect(eventNames).not.toContain("server.shutdown_failed");
  expect(eventNames).not.toContain("server.stopped");
};

export {
  RUNTIME_FAILURE,
  expectBootstrapActivationFailure,
  expectFatalRuntimeFailure,
  expectLifecycleOrder,
  makeMarkReadyWithFatalReport,
  makeRecordedBootstrapToken,
};
export type {
  BootstrapActivationFailureFixture,
  FatalRuntimeFixture,
  FatalRuntimeState,
  LifecycleCallback,
  ServerRuntimeLayer,
};
