import { spawn as nodeSpawn } from "node:child_process";

import { createConnectTransport } from "@connectrpc/connect-node";
import { Effect } from "effect";

import { observePluginChild, spawnFailure, writeLaunchDocument } from "./child.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import { makePluginLaunchDocument } from "./launch-document.ts";
import { attachPluginStderr } from "./logging.ts";
import type {
  AcquiredPluginProcess,
  PreparedPluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  RunningPlugin,
} from "./model.ts";
import { pluginSocketPath } from "./runtime.ts";

interface PluginProcessAdapter {
  readonly launch: NonNullable<PluginSpawnProcess>;
}

interface PluginConnection {
  readonly bearer: string;
  readonly document: string;
  readonly socketPath: string;
}

interface AcquirePluginProcessOptions {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launch: PreparedPluginLaunch;
  readonly launchDirectory: string;
  readonly spawnProcess: PluginSpawnProcess;
}

interface RunningPluginOptions {
  readonly child: RunningPlugin["child"];
  readonly connection: PluginConnection;
  readonly exit: RunningPlugin["exit"];
  readonly launchDirectory: string;
  readonly stop: RunningPlugin["stop"];
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
  launch: PreparedPluginLaunch,
): Effect.Effect<PluginConnection, PluginUnavailableFailure> => {
  const socketPath = pluginSocketPath(launchDirectory);
  return makePluginLaunchDocument(launch, socketPath).pipe(
    Effect.map(({ bearer, document }) => ({ bearer, document, socketPath })),
  );
};

const runningPlugin = ({
  child,
  connection,
  exit,
  launchDirectory,
  stop,
}: RunningPluginOptions): RunningPlugin => ({
  bearer: connection.bearer,
  child,
  exit,
  launchDirectory,
  socketPath: connection.socketPath,
  stop,
  transport: createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "1.1",
    nodeOptions: { socketPath: connection.socketPath },
  }),
});

const acquirePluginProcess = ({
  descriptor,
  launch,
  launchDirectory,
  spawnProcess,
}: AcquirePluginProcessOptions): Effect.Effect<AcquiredPluginProcess, PluginUnavailableFailure> =>
  Effect.gen(function* acquirePluginProcessEffect() {
    const connection = yield* makePluginConnection(launchDirectory, launch);
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
        const stop = { requested: false, unexpectedExit: false };
        return { child, lifecycle: observePluginChild(child, stop), stop };
      },
    });
    return {
      document: connection.document,
      launched: spawned.lifecycle.launched,
      plugin: runningPlugin({
        child: spawned.child,
        connection,
        exit: spawned.lifecycle.exit,
        launchDirectory,
        stop: spawned.stop,
      }),
    };
  });

const finishPluginStartup = (
  acquired: AcquiredPluginProcess,
  options: {
    readonly descriptor: PluginLaunchDescriptor;
    readonly emit: PluginLogEmitter;
    readonly launch: PreparedPluginLaunch;
  },
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  Effect.gen(function* finishPluginStartupEffect() {
    yield* Effect.tryPromise({ catch: spawnFailure, try: () => acquired.launched });
    acquired.plugin.child.stdout.resume();
    attachPluginStderr(
      acquired.plugin.child.stderr,
      { descriptor: options.descriptor, launch: options.launch },
      options.emit,
    );
    yield* writeLaunchDocument(acquired.plugin, acquired.document);
    return acquired.plugin;
  });

export { acquirePluginProcess, finishPluginStartup };
export type { AcquirePluginProcessOptions };
