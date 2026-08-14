// oxlint-disable eslint/func-style, eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements, eslint/sort-imports, eslint/sort-keys, import/exports-last, import/max-dependencies, import/no-nodejs-modules, promise/avoid-new, typescript/no-unsafe-assignment, typescript/prefer-readonly-parameter-types -- Disposable Node lifecycle harness adapts callback transports and returns one issue-level evidence record.
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConnectError, createClient } from "@connectrpc/connect";
import type { Code, Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { HealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import type { ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

export interface PluginIpcEvidence {
  readonly runtimeDirectoryMode: number;
  readonly firstHealthStatus: ServingStatus;
  readonly secondHealthStatus: ServingStatus;
  readonly healthAfterDeadlineStatus: ServingStatus;
  readonly firstItemTitle: string;
  readonly secondItemTitle: string;
  readonly firstItemKind: MediaKind;
  readonly secondItemKind: MediaKind;
  readonly invalidBearerCode: Code;
  readonly staleBearerCode: Code;
  readonly deadlineCode: Code;
  readonly firstExitCode: number;
  readonly secondExitCode: number;
  readonly filesAfterFirstStop: number;
  readonly filesAfterSecondStop: number;
  readonly sensitiveOutputAbsent: boolean;
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

interface RunningPlugin {
  readonly child: ChildProcess;
  readonly output: CapturedOutput;
}

interface SuccessfulCalls {
  readonly healthStatus: ServingStatus;
  readonly itemTitle: string;
  readonly itemKind: MediaKind;
}

const EMPTY_COUNT = 0;
const FAILURE_EXIT_CODE = 1;
const BEARER_BYTE_LENGTH = 32;
const RUNTIME_DIRECTORY_MODE = 0o700;
const FILE_MODE_MASK = 0o777;
const RPC_TIMEOUT_MS = 500;
const DEADLINE_PROBE_MS = 5;
const GET_ITEM_DELAY_MS = 75;
const CHILD_LIFECYCLE_TIMEOUT_MS = 2000;
const FIXTURE_ITEM_REFERENCE = "ipc-spike-item";
const SOCKET_FILENAME = "plugin.sock";
const CHILD_PATH = fileURLToPath(new URL("plugin-ipc-child.ts", import.meta.url));

function bearerInterceptor(bearer: string): Interceptor {
  return (next) => (request) => {
    request.header.set("authorization", `Bearer ${bearer}`);
    return next(request);
  };
}

function clients(socketPath: string, bearer: string) {
  const transport = createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "1.1",
    nodeOptions: { socketPath },
    interceptors: [bearerInterceptor(bearer)],
    acceptCompression: [],
  });
  return {
    health: createClient(HealthService, transport),
    library: createClient(LibraryService, transport),
  };
}

async function connectCode(operation: () => Promise<unknown>): Promise<Code> {
  try {
    await operation();
  } catch (error) {
    return ConnectError.from(error).code;
  }
  throw new Error("expected plugin RPC failure");
}

function collectOutput(child: ChildProcess): CapturedOutput {
  const output: CapturedOutput = { stdout: "", stderr: "" };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    output.stderr += chunk;
  });
  return output;
}

async function writeBootstrap(
  child: ChildProcess,
  socketPath: string,
  bearer: string,
): Promise<void> {
  const input = child.stdin;
  if (input === null) {
    throw new Error("plugin bootstrap pipe unavailable");
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      input.off("error", onError);
      input.off("finish", onFinish);
    };
    const onError = () => {
      cleanup();
      reject(new Error("plugin bootstrap write failed"));
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    input.once("error", onError);
    input.once("finish", onFinish);
    input.end(JSON.stringify({ socketPath, bearer, getItemDelayMs: GET_ITEM_DELAY_MS }));
  });
}

async function waitForReady(child: ChildProcess): Promise<void> {
  try {
    const [message] = await once(child, "message", {
      signal: AbortSignal.timeout(CHILD_LIFECYCLE_TIMEOUT_MS),
    });
    if (
      typeof message !== "object" ||
      message === null ||
      Reflect.get(message, "type") !== "ready"
    ) {
      throw new Error("plugin readiness invalid");
    }
  } catch {
    throw new Error("plugin child did not become ready");
  }
}

async function waitForClose(child: ChildProcess): Promise<number> {
  try {
    const [code] = await once(child, "close", {
      signal: AbortSignal.timeout(CHILD_LIFECYCLE_TIMEOUT_MS),
    });
    if (typeof code === "number") {
      return code;
    }
    return FAILURE_EXIT_CODE;
  } catch {
    throw new Error("plugin child did not stop");
  }
}

async function forceStop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const closed = waitForClose(child);
  child.kill("SIGKILL");
  try {
    await closed;
  } catch {
    throw new Error("plugin forced shutdown failed");
  }
}

async function launchPlugin(socketPath: string, bearer: string): Promise<RunningPlugin> {
  const child = fork(CHILD_PATH, [], {
    env: {},
    execArgv: ["--no-warnings"],
    stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const output = collectOutput(child);

  try {
    await writeBootstrap(child, socketPath, bearer);
    await waitForReady(child);
    return { child, output };
  } catch {
    await forceStop(child);
    throw new Error("plugin launch failed");
  }
}

function stopPlugin(plugin: RunningPlugin): Promise<number> {
  if (plugin.child.exitCode !== null) {
    return Promise.resolve(plugin.child.exitCode);
  }
  const closed = waitForClose(plugin.child);
  if (!plugin.child.kill("SIGTERM")) {
    throw new Error("plugin termination failed");
  }
  return closed;
}

async function successfulCalls(socketPath: string, bearer: string): Promise<SuccessfulCalls> {
  const client = clients(socketPath, bearer);
  const health = await client.health.check({}, { timeoutMs: RPC_TIMEOUT_MS });
  const response = await client.library.getItem(
    { itemReference: { itemId: FIXTURE_ITEM_REFERENCE } },
    { timeoutMs: RPC_TIMEOUT_MS },
  );
  if (response.item === undefined) {
    throw new Error("plugin item response missing");
  }
  return {
    healthStatus: health.status,
    itemTitle: response.item.title,
    itemKind: response.item.kind,
  };
}

export async function provePluginIpcLifecycle(): Promise<PluginIpcEvidence> {
  let runtimeDirectory: string | undefined = undefined;
  let firstPlugin: RunningPlugin | undefined = undefined;
  let secondPlugin: RunningPlugin | undefined = undefined;
  let firstBearer = "";
  let secondBearer = "";

  try {
    runtimeDirectory = await mkdtemp(join(tmpdir(), "nama-plugin-ipc-"));
    await chmod(runtimeDirectory, RUNTIME_DIRECTORY_MODE);
    const runtimeDirectoryStat = await stat(runtimeDirectory);
    const runtimeDirectoryMode = runtimeDirectoryStat.mode & FILE_MODE_MASK;
    const socketPath = join(runtimeDirectory, SOCKET_FILENAME);

    firstBearer = randomBytes(BEARER_BYTE_LENGTH).toString("base64url");
    firstPlugin = await launchPlugin(socketPath, firstBearer);
    const firstCalls = await successfulCalls(socketPath, firstBearer);
    const invalidBearerCode = await connectCode(() =>
      clients(socketPath, "invalid-spike-bearer").health.check({}, { timeoutMs: RPC_TIMEOUT_MS }),
    );
    const deadlineCode = await connectCode(() =>
      clients(socketPath, firstBearer).library.getItem(
        { itemReference: { itemId: FIXTURE_ITEM_REFERENCE } },
        { timeoutMs: DEADLINE_PROBE_MS },
      ),
    );
    const healthAfterDeadline = await clients(socketPath, firstBearer).health.check(
      {},
      { timeoutMs: RPC_TIMEOUT_MS },
    );
    const firstExitCode = await stopPlugin(firstPlugin);
    const filesAfterFirstStopEntries = await readdir(runtimeDirectory);
    const filesAfterFirstStop = filesAfterFirstStopEntries.length;

    secondBearer = randomBytes(BEARER_BYTE_LENGTH).toString("base64url");
    if (secondBearer === firstBearer) {
      throw new Error("plugin launch bearer was reused");
    }
    secondPlugin = await launchPlugin(socketPath, secondBearer);
    const staleBearerCode = await connectCode(() =>
      clients(socketPath, firstBearer).health.check({}, { timeoutMs: RPC_TIMEOUT_MS }),
    );
    const secondCalls = await successfulCalls(socketPath, secondBearer);
    const secondExitCode = await stopPlugin(secondPlugin);
    const filesAfterSecondStopEntries = await readdir(runtimeDirectory);
    const filesAfterSecondStop = filesAfterSecondStopEntries.length;

    const capturedOutput =
      firstPlugin.output.stdout +
      firstPlugin.output.stderr +
      secondPlugin.output.stdout +
      secondPlugin.output.stderr;
    const sensitiveOutputAbsent =
      capturedOutput.length === EMPTY_COUNT &&
      ![socketPath, firstBearer, secondBearer, FIXTURE_ITEM_REFERENCE].some((value) =>
        capturedOutput.includes(value),
      );

    return {
      runtimeDirectoryMode,
      firstHealthStatus: firstCalls.healthStatus,
      secondHealthStatus: secondCalls.healthStatus,
      healthAfterDeadlineStatus: healthAfterDeadline.status,
      firstItemTitle: firstCalls.itemTitle,
      secondItemTitle: secondCalls.itemTitle,
      firstItemKind: firstCalls.itemKind,
      secondItemKind: secondCalls.itemKind,
      invalidBearerCode,
      staleBearerCode,
      deadlineCode,
      firstExitCode,
      secondExitCode,
      filesAfterFirstStop,
      filesAfterSecondStop,
      sensitiveOutputAbsent,
    };
  } catch {
    throw new Error("plugin IPC lifecycle proof failed");
  } finally {
    if (firstPlugin !== undefined) {
      await forceStop(firstPlugin.child);
    }
    if (secondPlugin !== undefined) {
      await forceStop(secondPlugin.child);
    }
    if (runtimeDirectory !== undefined) {
      await rm(runtimeDirectory, { recursive: true, force: true });
    }
  }
}
