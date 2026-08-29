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

const MAXIMUM_LAUNCH_DOCUMENT_BYTES = 64 * 1024;
const CONTROL_DIRECTORY_INDEX = 2;
const MODE_INDEX = 3;
const controlDirectory = process.argv[CONTROL_DIRECTORY_INDEX];
const mode = process.argv[MODE_INDEX] ?? "normal";
const EXPECTED_CONFIGURATION_KEY = "base_url";
const EXPECTED_CONFIGURATION_VALUE = "fixture-configuration";
const EXPECTED_CREDENTIAL_KEY = "api_key";
const EXPECTED_CREDENTIAL_VALUE = "fixture-credential";
const ABSENT_ENVIRONMENT_PROBE_VALUE = "<absent>";

if (controlDirectory === undefined) {
  process.exitCode = 64;
  throw new Error("fixture control directory is required");
}

process.umask(0o177);

await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
await chmod(controlDirectory, 0o700);

/**
 * @param {Readonly<Record<string, unknown>>} value
 * @param {readonly string[]} expectedKeys
 * @returns {boolean}
 */
const hasExactKeys = (value, expectedKeys) => {
  const actualKeys = Object.keys(value).toSorted();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
};
/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const readLaunchDocument = async () => {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAXIMUM_LAUNCH_DOCUMENT_BYTES) {
      process.exitCode = 64;
      throw new Error("launch document exceeds its size bound");
    }
    chunks.push(chunk);
  }
  /** @type {unknown} */
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    typeof value.socket_path !== "string" ||
    typeof value.bearer !== "string"
  ) {
    process.exitCode = 64;
    throw new Error("launch document is malformed");
  }
  const commonKeys = ["bearer", "kind", "socket_path", "version"];
  if (value.kind === "discovery" && hasExactKeys(value, commonKeys)) {
    return value;
  }
  const providerKeys = ["configuration", "credentials", "provider_type"];
  const hasProviderContext =
    value.provider_type === "fixture" &&
    isRecord(value.configuration) &&
    isRecord(value.credentials);
  if (
    value.kind === "candidate" &&
    hasProviderContext &&
    hasExactKeys(value, [...commonKeys, ...providerKeys].toSorted())
  ) {
    return value;
  }
  if (
    value.kind === "instance" &&
    hasProviderContext &&
    hasExactKeys(
      value,
      [...commonKeys, ...providerKeys, "provider_instance_id", "revision"].toSorted(),
    ) &&
    typeof value.provider_instance_id === "string" &&
    typeof value.revision === "string"
  ) {
    return value;
  }
  process.exitCode = 64;
  throw new Error("launch document kind is invalid");
};

const launchDocument = await readLaunchDocument();
const providerContextAbsent = [
  "configuration",
  "credentials",
  "provider_instance_id",
  "provider_type",
  "revision",
].every((key) => !(key in launchDocument));
const providerContextMatchesFixture =
  launchDocument.provider_type === "fixture" &&
  launchDocument.configuration?.[EXPECTED_CONFIGURATION_KEY] === EXPECTED_CONFIGURATION_VALUE &&
  launchDocument.credentials?.[EXPECTED_CREDENTIAL_KEY] === EXPECTED_CREDENTIAL_VALUE;

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
const environmentProbe = Object.fromEntries(
  seededNames.map((name) => [name, process.env[name] ?? ABSENT_ENVIRONMENT_PROBE_VALUE]),
);

const environmentEmpty = Object.keys(process.env).every(
  (name) => process.platform === "darwin" && name === "__CF_USER_TEXT_ENCODING",
);
const seededEnvironmentAbsent = seededNames.every((name) => process.env[name] === undefined);
const excludedLaunchMaterial = [
  String(launchDocument.bearer),
  String(launchDocument.socket_path),
  EXPECTED_CONFIGURATION_KEY,
  EXPECTED_CONFIGURATION_VALUE,
  EXPECTED_CREDENTIAL_KEY,
  EXPECTED_CREDENTIAL_VALUE,
];
const argumentsExcludeLaunchMaterial = process.argv.every((argument) =>
  excludedLaunchMaterial.every((material) => !String(argument).includes(material)),
);
const argv = [...process.argv];
await appendFile(
  launchesPath,
  `${JSON.stringify({
    argumentsExcludeLaunchMaterial,
    bearer: launchDocument.bearer,
    argv,
    environmentEmpty,
    launchKind: launchDocument.kind,
    launchNumber,
    environmentProbe,
    pid: process.pid,
    providerContextAbsent,
    providerContextMatchesFixture,
    providerInstanceId: launchDocument.provider_instance_id,
    revision: launchDocument.revision,
    seededEnvironmentAbsent,
    socketPath: launchDocument.socket_path,
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
  (mode === "reset-episode" && (launchNumber === 2 || launchNumber === 3)) ||
  (mode === "idle-bounded-recovery" && launchNumber >= 2 && launchNumber <= 5)
) {
  await appendFile(join(controlDirectory, "exits.ndjson"), `${launchNumber}\n`, {
    mode: 0o600,
  });
  process.exit(17);
}
const waitForControlFile = async (filename) => {
  const controlPath = join(controlDirectory, filename);
  while (true) {
    try {
      await stat(controlPath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const delay = Promise.withResolvers();
      setTimeout(delay.resolve, 10);
      await delay.promise;
    }
  }
};

if (mode === "wait-start" || mode === "wait-start-cleanup-failure") {
  if (mode === "wait-start-cleanup-failure") {
    const failCleanup = async () => {
      await chmod(dirname(dirname(launchDocument.socket_path)), 0o500);
      process.exit(0);
    };
    process.once("SIGTERM", () => void failCleanup());
  }
  await waitForControlFile("continue");
}
if (mode === "wait-recovery" && launchNumber > 1) {
  await waitForControlFile("recovery-continue");
}

if (mode === "regular-socket") {
  const stopped = Promise.withResolvers();
  process.once("SIGINT", stopped.resolve);
  process.once("SIGTERM", stopped.resolve);
  const keepAlive = setInterval(() => {}, 1000);
  await writeFile(launchDocument.socket_path, "", { mode: 0o600 });
  await stopped.promise;
  clearInterval(keepAlive);
  process.exit(0);
}

const authorizationMatches = (context) =>
  mode !== "authentication-failure" &&
  context.requestHeader.get("authorization") === `Bearer ${String(launchDocument.bearer)}`;
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
let infoRequestCount = 0;

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
      getConnection: async (request, context) => {
        requireAuthorization(context);
        connectionRequestCount += 1;
        observeCancellation(context);
        const requestBoundary = `${JSON.stringify(request)} ${[...context.requestHeader.entries()]
          .flat()
          .join(" ")}`;
        const requestBoundaryClean = [
          EXPECTED_CONFIGURATION_KEY,
          EXPECTED_CONFIGURATION_VALUE,
          EXPECTED_CREDENTIAL_KEY,
          EXPECTED_CREDENTIAL_VALUE,
        ].every((material) => !requestBoundary.includes(material));
        await appendFile(
          join(controlDirectory, "request-boundary.ndjson"),
          `${requestBoundaryClean}\n`,
          { mode: 0o600 },
        );
        await appendFile(join(controlDirectory, "requests.ndjson"), "1\n", { mode: 0o600 });
        if (
          mode === "block-connection" ||
          (mode === "block-first-connection" && connectionRequestCount === 1) ||
          mode === "block-and-exit-after-ready-during-recovery"
        ) {
          const blockedRequest = Promise.withResolvers();
          context.signal.addEventListener(
            "abort",
            () => blockedRequest.reject(new ConnectError("cancelled", Code.Canceled)),
            { once: true },
          );
          await blockedRequest.promise;
        }
        if (mode === "wait-connection") {
          await waitForControlFile("connection-continue");
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
        infoRequestCount += 1;
        if (infoRequestCount > 1 && mode === "discovery-failure") {
          throw new ConnectError("fixture discovery failure", Code.Unavailable);
        }
        if (infoRequestCount > 1 && mode === "malformed-discovery") {
          return {};
        }
        const newerIncompatible = mode === "newer-incompatible";
        const jellyfinDiscoveryFixture =
          mode === "discovery-failure" || mode === "malformed-discovery" || newerIncompatible;
        let providerTypeId = "fixture";
        if (jellyfinDiscoveryFixture) {
          providerTypeId = "jellyfin";
        } else if (mode === "provider-mismatch") {
          providerTypeId = "other";
        }

        const pluginInfo = {
          buildVersion: newerIncompatible ? "fixture-2" : "fixture",
          capabilities: [],
          configurationSchema: {
            additionalProperties: false,
            properties: {},
            type: "object",
          },
          contractMajor: mode === "contract-major" ? 2 : 1,
          description: "Disposable supervisor fixture",
          displayName: "Fixture",
          providerTypeId,
          schemaProfileVersion: 1,
          schemaRevision: newerIncompatible ? "2" : "fixture-1",
        };
        if (
          (mode === "exit-after-ready-during-recovery" ||
            mode === "block-and-exit-after-ready-during-recovery") &&
          launchNumber === 2
        ) {
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
server.listen(launchDocument.socket_path, listening.resolve);
await listening.promise;
await chmod(launchDocument.socket_path, mode === "insecure-socket" ? 0o666 : 0o600);

if (mode === "wait-recovery" && launchNumber > 1) {
  await appendFile(join(controlDirectory, "ready.ndjson"), `${launchNumber}\n`, { mode: 0o600 });
}

if (mode === "stdout-secret") {
  process.stdout.write("stdout-secret-must-not-appear\n");
}

if (
  mode === "helper" ||
  mode === "helper-cleanup-failure" ||
  (mode === "reset-episode" && launchNumber === 1)
) {
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
  if (mode === "ignore-termination" || (mode === "wait-first-termination" && launchNumber === 1)) {
    await appendFile(join(controlDirectory, "termination-signals.ndjson"), "SIGTERM\n", {
      mode: 0o600,
    });
    if (mode === "ignore-termination") {
      stopping = false;
      return;
    }
    await waitForControlFile("termination-continue");
  }
  if (mode === "cleanup-failure" || mode === "helper-cleanup-failure") {
    await chmod(dirname(dirname(launchDocument.socket_path)), 0o500);
  }
  const closed = Promise.withResolvers();
  server.close(closed.resolve);
  await closed.promise;
  if (mode === "remove-artifacts") {
    await rm(launchDocument.socket_path, { force: true });
    await rm(dirname(launchDocument.socket_path), { recursive: true });
  }
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
await appendFile(join(controlDirectory, "termination-ready.ndjson"), `${launchNumber}\n`, {
  mode: 0o600,
});
