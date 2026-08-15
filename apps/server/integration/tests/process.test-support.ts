import type { ChildProcess } from "node:child_process";
import { fork } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";

import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, FileSystem, Option } from "effect";

import {
  HOST,
  reservePort,
  reserveSpecificPort,
} from "../../src/http/tests/network.test-support.ts";
import { migrationFailureMainModule } from "./migration-failure-main.test-support.ts";

const MASTER_KEY_BYTES = 32;
const MASTER_KEY_FILL = 9;
const STATUS_WAIT_MILLISECONDS = 6000;
const POLL_MILLISECONDS = 25;
const SERVER_ROOT = join(import.meta.dirname, "../../");
const MAIN_MODULE = join(SERVER_ROOT, "src/main.ts");
const MASTER_KEY = `base64:${Buffer.alloc(MASTER_KEY_BYTES, MASTER_KEY_FILL).toString("base64")}`;

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
        fork(mainModule, [], {
          cwd: SERVER_ROOT,
          env: { ...process.env, NAMA_CONFIG: configPath },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
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

const requestStatus = (target: StatusTarget) =>
  Effect.callback<Response, unknown>((resume) => {
    const location = new URL(target.path, target.origin);
    const onError = (cause: Error): void => {
      resume(Effect.fail(cause));
    };
    const request = httpRequest(
      {
        host: HOST,
        method: "GET",
        path: location.pathname,
        port: Number(location.port),
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        const status = response.statusCode;
        response.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
        });
        response.once("error", onError);
        response.once("end", () => {
          if (status === undefined) {
            resume(Effect.fail(new TypeError("expected an HTTP response status")));
            return;
          }
          const body = Uint8Array.from(Buffer.concat(chunks));
          resume(Effect.succeed(new Response(body, { status })));
        });
      },
    );
    request.once("error", onError);
    request.end();

    return Effect.sync(() => {
      request.destroy();
    });
  });

const pollStatus = (target: StatusTarget, deadline: number): Effect.Effect<Response> =>
  Effect.gen(function* statusPoll() {
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* Effect.die(
        new Error(`timed out waiting for ${target.path} status ${target.status}`),
      );
    }
    const response = yield* Effect.option(requestStatus(target));
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

const expectPortReleased = (origin: string) => reserveSpecificPort(Number(new URL(origin).port));

const eventsFrom = (runningProcess: RunningProcess): string[] =>
  runningProcess
    .stdout()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => eventFromLine(line));

export {
  MASTER_KEY,
  eventsFrom,
  expectPortReleased,
  recordFromLine,
  startProcess,
  startMigrationFailureProcess,
  stopProcess,
  waitForExit,
  waitForStatus,
};
export type { RunningProcess };
