import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { withReservedPort } from "../../src/http/tests/network.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import {
  BOOTSTRAP_TOKEN_PREFIX,
  bootstrapLinesFrom,
  recordFromLine,
  startProcess,
  stopProcess,
  structuredLinesFrom,
  waitForExit,
  waitForStatus,
  waitForStdout,
} from "./process.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";

const HTTP_OK = 200;
const SUCCESS_EXIT_CODE = 0;
const NO_BOOTSTRAP_OUTPUT = 0;
const EXPECTED_SINGLE_OUTPUT = 1;
const FIRST_OUTPUT_INDEX = 0;
const TOKEN_LENGTH = 43;
const PROCESS_TEST_TIMEOUT_MILLISECONDS = 60_000;
const FAILURE_TEST_TIMEOUT_MILLISECONDS = 10_000;
const CONFIGURED_USER_ID = "configured-administrator";
const CONFIGURED_USER_EMAIL = "configured-administrator@example.test";
const SERVER_READY_EVENT = '"event":"server.ready"';

const expectHealthy = (runningProcess: RunningProcess) =>
  Effect.gen(function* healthyProcessAssertion() {
    const live = yield* waitForStatus(runningProcess.origin, "/health/live", HTTP_OK);
    const ready = yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
    expect(yield* Effect.promise(() => live.text())).toBe("");
    expect(yield* Effect.promise(() => ready.text())).toBe("");
    yield* waitForStdout(runningProcess, SERVER_READY_EVENT);
  });

const bootstrapTokenFrom = (runningProcess: RunningProcess): string => {
  const bootstrapLines = bootstrapLinesFrom(runningProcess);
  expect(bootstrapLines.length).toBe(EXPECTED_SINGLE_OUTPUT);
  const bootstrapLine = bootstrapLines.at(FIRST_OUTPUT_INDEX) ?? "";
  expect(bootstrapLine.startsWith(BOOTSTRAP_TOKEN_PREFIX)).toBe(true);
  const token = bootstrapLine.slice(BOOTSTRAP_TOKEN_PREFIX.length);
  expect(token.length).toBe(TOKEN_LENGTH);
  expect(/^[A-Za-z0-9_-]+$/u.test(token)).toBe(true);
  return token;
};

const expectSecretAbsentOutsideBootstrap = (
  runningProcess: RunningProcess,
  token: string,
): void => {
  const structuredOutput = structuredLinesFrom(runningProcess);
  for (const line of structuredOutput) {
    expect(recordFromLine(line)).toBeTypeOf("object");
  }
  expect(structuredOutput.some((line) => line.includes(token))).toBe(false);
  expect(runningProcess.stderr().includes(token)).toBe(false);
};

it.live(
  "emits one bootstrap token after binding and before readiness",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* bootstrapProcessTest() {
        const runningProcess = yield* startProcess(databaseUrl);
        yield* expectHealthy(runningProcess);

        const token = bootstrapTokenFrom(runningProcess);
        expectSecretAbsentOutsideBootstrap(runningProcess, token);
        const output = runningProcess.stdout();
        expect(output.indexOf(BOOTSTRAP_TOKEN_PREFIX)).toBeLessThan(
          output.indexOf('"event":"server.ready"'),
        );

        const exit = yield* stopProcess(runningProcess, "SIGTERM");
        expect(exit.code).toBe(SUCCESS_EXIT_CODE);
      }),
    ),
  PROCESS_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "does not emit a bootstrap token from a configured database",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* configuredBootstrapTest() {
        yield* useDatabase(
          databaseUrl,
          productionMigrations,
          (database) => database.checkReadiness,
        );
        yield* withPool(databaseUrl, (fixture) =>
          Effect.promise(async () => {
            await fixture.query('INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [
              CONFIGURED_USER_ID,
              "Configured Administrator",
              CONFIGURED_USER_EMAIL,
            ]);
            await fixture.query(
              "UPDATE nama_server_state SET initialized_at = CURRENT_TIMESTAMP, administrator_user_id = $1 WHERE \"key\" = 'server'",
              [CONFIGURED_USER_ID],
            );
          }),
        );

        const runningProcess = yield* startProcess(databaseUrl);
        yield* expectHealthy(runningProcess);
        expect(bootstrapLinesFrom(runningProcess).length).toBe(NO_BOOTSTRAP_OUTPUT);

        const exit = yield* stopProcess(runningProcess, "SIGTERM");
        expect(exit.code).toBe(SUCCESS_EXIT_CODE);
      }),
    ),
  PROCESS_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "replaces an unused bootstrap token after restart",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* restartBootstrapTest() {
        const firstProcess = yield* startProcess(databaseUrl);
        yield* expectHealthy(firstProcess);
        const firstToken = bootstrapTokenFrom(firstProcess);
        expect((yield* stopProcess(firstProcess, "SIGTERM")).code).toBe(SUCCESS_EXIT_CODE);

        const secondProcess = yield* startProcess(databaseUrl);
        yield* expectHealthy(secondProcess);
        const secondToken = bootstrapTokenFrom(secondProcess);
        expect(firstToken === secondToken).toBe(false);
        expectSecretAbsentOutsideBootstrap(secondProcess, secondToken);
        expect((yield* stopProcess(secondProcess, "SIGTERM")).code).toBe(SUCCESS_EXIT_CODE);
      }),
    ),
  PROCESS_TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "does not emit a bootstrap token when listener binding fails",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      withReservedPort((port) =>
        Effect.gen(function* bindFailureBootstrapTest() {
          const runningProcess = yield* startProcess(databaseUrl, port);
          const exit = yield* waitForExit(runningProcess.child);

          expect(exit.code).not.toBe(SUCCESS_EXIT_CODE);
          expect(bootstrapLinesFrom(runningProcess).length).toBe(NO_BOOTSTRAP_OUTPUT);
        }),
      ),
    ),
  FAILURE_TEST_TIMEOUT_MILLISECONDS,
);
