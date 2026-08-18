#!/usr/bin/env node
// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-await-in-loop, eslint/no-magic-numbers, eslint/no-ternary, sort-keys, unicorn/no-await-expression-member, unicorn/prefer-string-raw -- This disposable fixture keeps protocol variants explicit.
// oxlint-disable typescript/no-implied-eval, typescript/no-unsafe-argument, typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return, typescript/strict-void-return -- Oxlint cannot recover Node and Connect types for this executable JavaScript fixture.
// fallow-ignore-file unused-file -- The supervisor integration test executes this fixture by absolute path.

import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";

const MAXIMUM_ENVELOPE_BYTES = 4096;
const CONTROL_DIRECTORY_INDEX = 2;
const MODE_INDEX = 3;
const controlDirectory = process.argv[CONTROL_DIRECTORY_INDEX];
const mode = process.argv[MODE_INDEX] ?? "normal";

if (controlDirectory === undefined) {
  process.exitCode = 64;
  throw new Error("fixture control directory is required");
}

process.umask(0o177);

await mkdir(controlDirectory, { recursive: true, mode: 0o700 });

const readEnvelope = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAXIMUM_ENVELOPE_BYTES) {
      process.exit(64);
    }
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    value === null ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.socket_path !== "string" ||
    typeof value.bearer !== "string"
  ) {
    process.exit(64);
  }
  return value;
};

const envelope = await readEnvelope();
const launchesPath = join(controlDirectory, "launches.ndjson");
let priorLaunchCount = 0;
try {
  priorLaunchCount = (await readFile(launchesPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean).length;
} catch (error) {
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
const launchNumber = priorLaunchCount + 1;
const seededNames = [
  "NAMA_DATABASE_URL",
  "NAMA_MASTER_KEY",
  "NAMA_PROVIDER_CREDENTIAL",
  "NAMA_PLUGIN_LAUNCH_SECRET",
];
const environmentEmpty = Object.keys(process.env).every(
  (name) => process.platform === "darwin" && name === "__CF_USER_TEXT_ENCODING",
);
const seededEnvironmentAbsent = seededNames.every((name) => process.env[name] === undefined);
const argumentsExcludeLaunchMaterial = process.argv.every(
  (argument) => argument !== envelope.bearer && argument !== envelope.socket_path,
);
await appendFile(
  launchesPath,
  `${JSON.stringify({
    argumentsExcludeLaunchMaterial,
    bearer: envelope.bearer,
    environmentEmpty,
    launchNumber,
    pid: process.pid,
    seededEnvironmentAbsent,
    socketPath: envelope.socket_path,
  })}\n`,
  { mode: 0o600 },
);

if (mode === "launch-reject") {
  await appendFile(join(controlDirectory, "exits.ndjson"), `${launchNumber}\n`, {
    mode: 0o600,
  });
  process.exit(64);
}
if (
  mode === "always-exit-before-ready" ||
  mode === "exit-before-ready" ||
  (mode === "recover-twice" && launchNumber <= 2) ||
  (mode === "reset-episode" && (launchNumber === 2 || launchNumber === 3))
) {
  await appendFile(join(controlDirectory, "exits.ndjson"), `${launchNumber}\n`, {
    mode: 0o600,
  });
  process.exit(17);
}
if (mode === "wait-start") {
  const continuePath = join(controlDirectory, "continue");
  while (true) {
    try {
      await stat(continuePath);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const delay = Promise.withResolvers();
      setTimeout(delay.resolve, 10);
      await delay.promise;
    }
  }
}
if (mode === "wait-recovery" && launchNumber > 1) {
  const continuePath = join(controlDirectory, "recovery-continue");
  while (true) {
    try {
      await stat(continuePath);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const delay = Promise.withResolvers();
      setTimeout(delay.resolve, 10);
      await delay.promise;
    }
  }
}

if (mode === "regular-socket") {
  const stopped = Promise.withResolvers();
  process.once("SIGINT", stopped.resolve);
  process.once("SIGTERM", stopped.resolve);
  const keepAlive = setInterval(() => {}, 1000);
  await writeFile(envelope.socket_path, "", { mode: 0o600 });
  await stopped.promise;
  clearInterval(keepAlive);
  process.exit(0);
}

const authorizationMatches = (context) =>
  mode !== "authentication-failure" &&
  context.requestHeader.get("authorization") === `Bearer ${envelope.bearer}`;
const requireAuthorization = (context) => {
  if (!authorizationMatches(context)) {
    throw new ConnectError("authentication failed", Code.Unauthenticated);
  }
};
const observeCancellation = (context) => {
  context.signal.addEventListener(
    "abort",
    () => {
      void appendFile(join(controlDirectory, "cancellations.ndjson"), "1\n", { mode: 0o600 });
    },
    { once: true },
  );
};

let connectionRequestCount = 0;

const handler = connectNodeAdapter({
  routes: (router) => {
    router.service(HealthService, {
      check: (_request, context) => {
        requireAuthorization(context);
        return {
          status:
            mode === "handshake-not-serving" ? ServingStatus.NOT_SERVING : ServingStatus.SERVING,
        };
      },
    });
    router.service(PluginService, {
      getConnection: async (_request, context) => {
        requireAuthorization(context);
        connectionRequestCount += 1;
        observeCancellation(context);
        await appendFile(join(controlDirectory, "requests.ndjson"), "1\n", { mode: 0o600 });
        if (
          mode === "block-connection" ||
          (mode === "block-first-connection" && connectionRequestCount === 1)
        ) {
          const blockedRequest = Promise.withResolvers();
          context.signal.addEventListener(
            "abort",
            () => blockedRequest.reject(new ConnectError("cancelled", Code.Canceled)),
            { once: true },
          );
          await blockedRequest.promise;
        }
        if (mode === "rpc-deadline") {
          throw new ConnectError("fixture deadline", Code.DeadlineExceeded);
        }
        if (mode === "rpc-not-found") {
          throw new ConnectError("fixture not found", Code.NotFound);
        }
        if (mode === "crash-connection" && launchNumber === 1) {
          process.kill(process.pid, "SIGKILL");
          const crashedRequest = Promise.withResolvers();
          await crashedRequest.promise;
        }
        if (mode === "stderr-lines") {
          const records = await readFile(join(controlDirectory, "stderr.ndjson"), "utf8");
          const written = Promise.withResolvers();
          process.stderr.write(records, written.resolve);
          await written.promise;
          await appendFile(join(controlDirectory, "stderr-complete"), "1\n", {
            mode: 0o600,
          });
        }
        return {
          connection: {
            capabilities: [],
            status: 1,
          },
        };
      },
      getInfo: (_request, context) => {
        requireAuthorization(context);
        const pluginInfo = {
          buildVersion: "fixture",
          capabilities: [],
          configurationSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          contractMajor: mode === "contract-major" ? 2 : 1,
          description: "Disposable supervisor fixture",
          displayName: "Fixture",
          providerTypeId: mode === "provider-mismatch" ? "other" : "fixture",
          schemaProfileVersion: 1,
          schemaRevision: "fixture-1",
        };
        if (mode === "exit-after-ready-during-recovery" && launchNumber === 2) {
          setImmediate(() => process.kill(process.pid, "SIGKILL"));
        }
        return { pluginInfo };
      },
    });
  },
});

if (mode === "insecure-socket") {
  process.umask(0);
}

const server = createServer(handler);
const listening = Promise.withResolvers();
server.once("error", listening.reject);
server.listen(envelope.socket_path, listening.resolve);
await listening.promise;
await chmod(envelope.socket_path, mode === "insecure-socket" ? 0o666 : 0o600);

if (mode === "stdout-secret") {
  process.stdout.write("stdout-secret-must-not-appear\n");
}

if (mode === "helper") {
  const helper = spawn(process.execPath, [
    "-e",
    'process.on("SIGTERM",()=>{});process.stdout.write("ready\\n");setInterval(()=>{},1000)',
  ]);
  const helperReady = Promise.withResolvers();
  helper.once("error", helperReady.reject);
  helper.stdout.once("data", helperReady.resolve);
  await helperReady.promise;
  await appendFile(join(controlDirectory, "helper-pid"), `${helper.pid}\n`, { mode: 0o600 });
}

let stopping = false;
const stop = async () => {
  if (stopping) {
    return;
  }
  stopping = true;
  if (mode === "ignore-termination") {
    stopping = false;
    return;
  }
  if (mode === "cleanup-failure") {
    await chmod(dirname(dirname(envelope.socket_path)), 0o500);
  }
  const closed = Promise.withResolvers();
  server.close(closed.resolve);
  await closed.promise;
  if (mode === "remove-artifacts") {
    await rm(envelope.socket_path, { force: true });
    await rm(dirname(envelope.socket_path), { recursive: true });
  }
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
