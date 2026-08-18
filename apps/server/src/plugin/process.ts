import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { createConnectTransport } from "@connectrpc/connect-node";
import { Effect } from "effect";

import { observePluginChild, spawnFailure, writeLaunchEnvelope } from "./child.ts";
import {
  ENVELOPE_VERSION,
  MAXIMUM_ENVELOPE_BYTES,
  MAXIMUM_SOCKET_PATH_BYTES,
  PLUGIN_BEARER_BYTES,
  SOCKET_FILENAME,
} from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import { attachPluginStderr } from "./logging.ts";
import type {
  AcquiredPluginProcess,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  RunningPlugin,
} from "./model.ts";

interface PluginProcessAdapter {
  readonly launch: NonNullable<PluginSpawnProcess>;
}

interface PluginConnection {
  readonly bearer: string;
  readonly envelope: string;
  readonly socketPath: string;
}

interface AcquirePluginProcessOptions {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launchDirectory: string;
  readonly spawnProcess: PluginSpawnProcess;
}
interface RunningPluginOptions {
  readonly child: RunningPlugin["child"];
  readonly connection: PluginConnection;
  readonly exit: RunningPlugin["exit"];
  readonly launchDirectory: string;
}

const bundledPluginProcessAdapter: PluginProcessAdapter = Object.freeze({ launch: nodeSpawn });

const pluginProcessSpawner = (
  spawnProcess: PluginSpawnProcess,
): NonNullable<PluginSpawnProcess> => {
  if (spawnProcess !== undefined) {
    return spawnProcess;
  }
  return bundledPluginProcessAdapter.launch;
};

const makePluginConnection = (
  launchDirectory: string,
): Effect.Effect<PluginConnection, PluginUnavailableFailure> => {
  const bearer = randomBytes(PLUGIN_BEARER_BYTES).toString("base64url");
  const socketPath = join(launchDirectory, SOCKET_FILENAME);
  const envelope = JSON.stringify({
    bearer,
    socket_path: socketPath,
    version: ENVELOPE_VERSION,
  });
  if (
    Buffer.byteLength(socketPath, "utf8") > MAXIMUM_SOCKET_PATH_BYTES ||
    Buffer.byteLength(envelope, "utf8") > MAXIMUM_ENVELOPE_BYTES
  ) {
    return Effect.fail(unavailable("socket_invalid"));
  }
  return Effect.succeed({ bearer, envelope, socketPath });
};

const runningPlugin = ({
  child,
  connection,
  exit,
  launchDirectory,
}: RunningPluginOptions): RunningPlugin => ({
  bearer: connection.bearer,
  child,
  exit,
  launchDirectory,
  requestedStop: false,
  socketPath: connection.socketPath,
  transport: createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "1.1",
    nodeOptions: { socketPath: connection.socketPath },
  }),
});

const acquirePluginProcess = ({
  descriptor,
  launchDirectory,
  spawnProcess,
}: AcquirePluginProcessOptions): Effect.Effect<AcquiredPluginProcess, PluginUnavailableFailure> =>
  Effect.gen(function* acquirePluginProcessEffect() {
    const connection = yield* makePluginConnection(launchDirectory);
    const spawned = yield* Effect.try({
      catch: spawnFailure,
      try: () => {
        const child = pluginProcessSpawner(spawnProcess)(
          descriptor.executable,
          [...descriptor.arguments],
          {
            detached: true,
            env: {},
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        return { child, lifecycle: observePluginChild(child) };
      },
    });
    return {
      envelope: connection.envelope,
      launched: spawned.lifecycle.launched,
      plugin: runningPlugin({
        child: spawned.child,
        connection,
        exit: spawned.lifecycle.exit,
        launchDirectory,
      }),
    };
  });

const finishPluginStartup = (
  acquired: AcquiredPluginProcess,
  descriptor: PluginLaunchDescriptor,
  emit: PluginLogEmitter,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  Effect.gen(function* finishPluginStartupEffect() {
    yield* Effect.tryPromise({ catch: spawnFailure, try: () => acquired.launched });
    acquired.plugin.child.stdout.resume();
    attachPluginStderr(acquired.plugin.child.stderr, descriptor, emit);
    yield* writeLaunchEnvelope(acquired.plugin, acquired.envelope);
    return acquired.plugin;
  });

export { acquirePluginProcess, finishPluginStartup };
export type { AcquirePluginProcessOptions };
