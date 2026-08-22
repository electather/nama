import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { startProcess, stopProcess, waitForStatus } from "./process.test-support.ts";

const BROWSER_FIXTURE = join(import.meta.dirname, "fixtures/nw-browser.swift");
const BROWSER_TIMEOUT_MILLISECONDS = 15_000;
const TEST_TIMEOUT_MILLISECONDS = 30_000;
const HTTP_OK = 200;
const SUCCESS_EXIT_CODE = 0;

// oxlint-disable-next-line typescript/strict-void-return -- Node's overloaded callback API needs promisify's value-returning adapter.
const execFilePromise = promisify(execFile);

const browseUrl = (expectedUrl: string) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: () =>
      execFilePromise("xcrun", ["swift", BROWSER_FIXTURE, expectedUrl], {
        encoding: "utf8",
        timeout: BROWSER_TIMEOUT_MILLISECONDS,
      }),
  }).pipe(Effect.map(({ stdout }) => stdout.trim()));

it.live.skipIf(process.platform !== "darwin")(
  "publishes the canonical TXT URL to a real Apple NWBrowser",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.scoped(
        Effect.gen(function* nativeLanDiscoveryTest() {
          const runningProcess = yield* startProcess(databaseUrl, undefined, {
            lanDiscovery: true,
          });
          yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
          const expectedUrl = `${runningProcess.origin}/`;
          const discoveredUrl = yield* browseUrl(expectedUrl);

          expect(discoveredUrl).toBe(expectedUrl);
          const exit = yield* stopProcess(runningProcess, "SIGTERM");
          expect(exit.code).toBe(SUCCESS_EXIT_CODE);
        }),
      ),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);
