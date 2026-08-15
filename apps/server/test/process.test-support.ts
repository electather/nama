import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, FileSystem, Option } from "effect";
import { Pool } from "pg";

import { migrationFailureMainModule } from "./migration-failure-main.test-support.ts";
import { HOST, reservePort } from "./network.test-support.ts";

const SINGLE_CONNECTION = 1;
const MASTER_KEY_BYTES = 32;
const MASTER_KEY_FILL = 9;
const STATUS_WAIT_MILLISECONDS = 6000;
const POLL_MILLISECONDS = 25;
const SERVER_ROOT = join(import.meta.dirname, "../");
const MAIN_MODULE = join(SERVER_ROOT, "src/main.ts");
const MASTER_KEY = `base64:${Buffer.alloc(MASTER_KEY_BYTES, MASTER_KEY_FILL).toString("base64")}`;

const integrationUrl = (() => {
  const value = process.env["NAMA_TEST_DATABASE_URL"];
  if (value === undefined) {
    throw new Error("NAMA_TEST_DATABASE_URL is required for process integration tests");
  }
  return value;
})();

interface RunningProcess {
  readonly child: ChildProcess;
  readonly origin: string;
  readonly stderr: () => string;
  readonly stdout: () => string;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface OutputCapture {
  readonly append: (chunk: string) => void;
  readonly read: () => string;
}

interface StatusTarget {
  readonly origin: string;
  readonly path: string;
  readonly status: number;
}

const waitForExit = (child: ChildProcess) =>
  Effect.suspend(() => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Effect.succeed({ code: child.exitCode, signal: child.signalCode });
    }
    return Effect.callback<ProcessExit, Error>((resume) => {
      const cleanup = (): void => {
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        resume(Effect.fail(error));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        resume(Effect.succeed({ code, signal }));
      };
      child.once("error", onError);
      child.once("exit", onExit);
      return Effect.sync(cleanup);
    });
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordFromLine = (line: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value)) {
    throw new TypeError("expected a structured log record");
  }
  return value;
};

const eventFromLine = (line: string): string => {
  const { event } = recordFromLine(line);
  if (typeof event !== "string") {
    throw new TypeError("expected a structured event record");
  }
  return event;
};

const configuration = (databaseUrl: string, port: number): string => `[server]
bind = "${HOST}:${port}"
public_url = "http://${HOST}:${port}"

[database]
url = "${databaseUrl}"
max_connections = 2

[security]
master_key = "${MASTER_KEY}"

[logging]
level = "info"
`;

const outputCapture = (): OutputCapture => {
  let output = "";
  return {
    append: (chunk) => {
      output += chunk;
    },
    read: () => output,
  };
};

const captureOutput = (child: ChildProcess, stdout: OutputCapture, stderr: OutputCapture): void => {
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", stdout.append);
  child.stderr?.on("data", stderr.append);
};

const killChildIfRunning = (child: ChildProcess): void => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
};

const startProcess = (databaseUrl: string, mainModule: string = MAIN_MODULE) =>
  Effect.gen(function* runningServerProcess() {
    const port = yield* reservePort;
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "nama-server-process-",
    });
    const configPath = join(directory, "nama.toml");
    yield* fileSystem.writeFileString(configPath, configuration(databaseUrl, port));
    const stdout = outputCapture();
    const stderr = outputCapture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(process.execPath, [mainModule], {
          cwd: SERVER_ROOT,
          env: { ...process.env, NAMA_CONFIG: configPath },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
      (acquired) =>
        Effect.sync(() => {
          killChildIfRunning(acquired);
        }),
    );
    captureOutput(child, stdout, stderr);
    return { child, origin: `http://${HOST}:${port}`, stderr: stderr.read, stdout: stdout.read };
  }).pipe(Effect.provide(NodeFileSystem.layer));

const startMigrationFailureProcess = (databaseUrl: string) =>
  startProcess(databaseUrl, migrationFailureMainModule);

const pollStatus = (target: StatusTarget, deadline: number): Effect.Effect<Response> =>
  Effect.gen(function* statusPoll() {
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* Effect.die(
        new Error(`timed out waiting for ${target.path} status ${target.status}`),
      );
    }
    const response = yield* Effect.option(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => fetch(`${target.origin}${target.path}`),
      }),
    );
    if (Option.isSome(response) && response.value.status === target.status) {
      return response.value;
    }
    yield* Effect.sleep(POLL_MILLISECONDS);
    return yield* pollStatus(target, deadline);
  });

const waitForStatus = (origin: string, path: string, status: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => pollStatus({ origin, path, status }, now + STATUS_WAIT_MILLISECONDS)),
  );
const stopProcess = (runningProcess: RunningProcess, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    runningProcess.child.kill(signal);
  }).pipe(Effect.andThen(waitForExit(runningProcess.child)));

const expectPortReleased = (origin: string) =>
  Effect.acquireUseRelease(
    Effect.sync(createServer),
    (reservation) =>
      Effect.promise(async () => {
        reservation.listen(Number(new URL(origin).port), HOST);
        await once(reservation, "listening");
      }),
    (reservation) => Effect.promise(() => reservation[Symbol.asyncDispose]()),
  );

const withIsolatedDatabase = <Result, Error, Requirements>(
  use: (databaseUrl: string) => Effect.Effect<Result, Error, Requirements>,
) => {
  const databaseName = `nama_process_${crypto.randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(integrationUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return Effect.acquireUseRelease(
    Effect.sync(() => new Pool({ connectionString: integrationUrl, max: SINGLE_CONNECTION })),
    (admin) =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          await admin.query(`CREATE DATABASE "${databaseName}"`);
          return databaseUrl.toString();
        }),
        (url) => Effect.scoped(use(url)),
        () =>
          Effect.promise(async () => {
            await admin.query(
              "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
              [databaseName],
            );
            await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
          }),
      ),
    (admin) => Effect.promise(() => admin.end()),
  );
};

const eventsFrom = (runningProcess: RunningProcess): string[] =>
  runningProcess
    .stdout()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => eventFromLine(line));

export {
  MASTER_KEY,
  SINGLE_CONNECTION,
  eventsFrom,
  expectPortReleased,
  integrationUrl,
  recordFromLine,
  startProcess,
  startMigrationFailureProcess,
  stopProcess,
  waitForExit,
  waitForStatus,
  withIsolatedDatabase,
};
export type { RunningProcess };
