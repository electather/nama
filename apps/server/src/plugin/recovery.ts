import { Effect, Fiber } from "effect";

import { stopPlugin } from "./cleanup.ts";
import { HEALTHY_EPISODE_RESET_MILLISECONDS } from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import { recoverPlugin } from "./launch.ts";
import type { RecoveryPluginOptions, RecoveryResult } from "./launch.ts";
import { pluginLifecycleMessage } from "./logging.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type {
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  ProcessExit,
  RunningPlugin,
} from "./model.ts";

const SINGLE_RECOVERY_PERMIT = 1;
const NO_RECOVERY_DELAY_MILLISECONDS = 0;

interface RecoveryOptions {
  readonly descriptor: PluginLaunchDescriptor;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly runtimeRoot: string;
  readonly spawnProcess: PluginSpawnProcess;
}

interface BeginRecoveryOptions extends RecoveryOptions {
  readonly graceMilliseconds: number;
  readonly plugin: RunningPlugin;
}

type RunningPluginSelection =
  | Readonly<{
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovery";
    }>
  | Readonly<{ readonly kind: "ready"; readonly plugin: RunningPlugin }>;

const stopPriorPlugin = (
  plugin: RunningPlugin | typeof ABSENT_PLUGIN,
  graceMilliseconds: number,
): Effect.Effect<void, PluginUnavailableFailure> => {
  if (plugin === ABSENT_PLUGIN) {
    return Effect.void;
  }
  return Effect.sleep(graceMilliseconds).pipe(
    Effect.andThen(stopPlugin(plugin)),
    Effect.mapError(() => unavailable("plugin_exited")),
  );
};

const forkPluginWatchers = (
  state: PluginHandleState,
  options: RecoveryOptions,
  plugin: RunningPlugin,
): Effect.Effect<void> => {
  const exitWatcher = forkPluginExitWatcher(state, options, plugin);
  const episodeReset = forkHealthyEpisodeReset(state, plugin);
  return Effect.all([exitWatcher, episodeReset], { concurrency: "unbounded", discard: true });
};

const markPluginRecovered = (
  state: PluginHandleState,
  options: RecoveryOptions,
  result: Readonly<{ readonly launchesInEpisode: number; readonly plugin: RunningPlugin }>,
): Effect.Effect<void> =>
  Effect.gen(function* markPluginRecovery() {
    state.current = result.plugin;
    state.launchesInEpisode = result.launchesInEpisode;
    state.unhealthy = false;
    yield* forkPluginWatchers(state, options, result.plugin);
  });

const recoveryProcess = (
  state: PluginHandleState,
  options: RecoveryOptions,
  graceMilliseconds: number,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  const recoveryOptions: RecoveryPluginOptions = {
    descriptor: options.descriptor,
    effectiveUserId: options.effectiveUserId,
    emit: options.emit,
    priorLaunches: state.launchesInEpisode,
    runtimeRoot: options.runtimeRoot,
    spawnProcess: options.spawnProcess,
  };
  const launch: Effect.Effect<RecoveryResult, PluginUnavailableFailure> =
    recoverPlugin(recoveryOptions);
  return stopPriorPlugin(state.current, graceMilliseconds).pipe(
    Effect.andThen(launch),
    Effect.tap((result) => markPluginRecovered(state, options, result)),
    Effect.map((result) => result.plugin),
    Effect.tapError((failure) =>
      Effect.sync(() => {
        state.terminal = failure;
      }),
    ),
    Effect.onExit(() =>
      Effect.sync(() => {
        state.recoveryFiber = undefined;
      }),
    ),
  );
};

const forkPluginRecovery = (
  state: PluginHandleState,
  options: RecoveryOptions,
  graceMilliseconds: number,
): Effect.Effect<Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>> =>
  Effect.gen(function* forkPluginRecoveryProcess() {
    state.unhealthy = true;
    const recovery = recoveryProcess(state, options, graceMilliseconds);
    const fiber = yield* Effect.forkIn(recovery, state.scope);
    state.recoveryFiber = fiber;
    return fiber;
  });

const beginPluginRecovery = (
  state: PluginHandleState,
  options: BeginRecoveryOptions,
): Effect.Effect<void> =>
  state.recoveryLock.withPermits(SINGLE_RECOVERY_PERMIT)(
    Effect.suspend(() => {
      if (
        state.terminal !== undefined ||
        state.current !== options.plugin ||
        state.recoveryFiber !== undefined
      ) {
        return Effect.void;
      }
      return forkPluginRecovery(state, options, options.graceMilliseconds).pipe(Effect.asVoid);
    }),
  );

const processExitFields = (
  processExit: ProcessExit,
): {
  exitCode?: number;
  signal?: NodeJS.Signals;
} => {
  const fields: { exitCode?: number; signal?: NodeJS.Signals } = {};
  if (processExit.code !== null) {
    fields.exitCode = processExit.code;
  }
  if (processExit.signal !== null) {
    fields.signal = processExit.signal;
  }
  return fields;
};

const processExitLogEffect = (
  descriptor: PluginLaunchDescriptor,
  processExit: ProcessExit,
): Effect.Effect<void> =>
  Effect.logWarning(
    pluginLifecycleMessage(descriptor, "plugin.process_exited", processExitFields(processExit)),
  );

const forkPluginExitWatcher = (
  state: PluginHandleState,
  options: RecoveryOptions,
  plugin: RunningPlugin,
): Effect.Effect<void> =>
  Effect.promise(() => plugin.exit).pipe(
    Effect.flatMap((processExit) => {
      if (plugin.requestedStop) {
        return Effect.void;
      }
      options.emit(processExitLogEffect(options.descriptor, processExit));
      return beginPluginRecovery(state, {
        ...options,
        graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
        plugin,
      });
    }),
    Effect.forkIn(state.scope),
    Effect.asVoid,
  );

const forkHealthyEpisodeReset = (
  state: PluginHandleState,
  plugin: RunningPlugin,
): Effect.Effect<void> =>
  Effect.sleep(HEALTHY_EPISODE_RESET_MILLISECONDS).pipe(
    Effect.andThen(
      Effect.sync(() => {
        if (
          state.current === plugin &&
          !state.unhealthy &&
          state.terminal === undefined &&
          plugin.child.exitCode === null &&
          plugin.child.signalCode === null
        ) {
          state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
        }
      }),
    ),
    Effect.forkIn(state.scope),
    Effect.asVoid,
  );

const awaitRecoverySelection = (
  selection: RunningPluginSelection,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  if (selection.kind === "recovery") {
    return Fiber.join(selection.fiber);
  }
  return Effect.succeed(selection.plugin);
};

const ensureRunningPlugin = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  state.recoveryLock
    .withPermits(SINGLE_RECOVERY_PERMIT)(
      Effect.suspend<RunningPluginSelection, PluginUnavailableFailure, never>(() => {
        if (state.closed) {
          return Effect.fail(unavailable("plugin_exited"));
        }
        if (state.terminal !== undefined) {
          return Effect.fail(state.terminal);
        }
        if (state.recoveryFiber !== undefined) {
          return Effect.succeed({ fiber: state.recoveryFiber, kind: "recovery" });
        }
        if (
          state.current !== ABSENT_PLUGIN &&
          !state.unhealthy &&
          state.current.child.exitCode === null &&
          state.current.child.signalCode === null
        ) {
          return Effect.succeed({ kind: "ready", plugin: state.current });
        }
        return forkPluginRecovery(state, options, NO_RECOVERY_DELAY_MILLISECONDS).pipe(
          Effect.map((fiber) => ({ fiber, kind: "recovery" as const })),
        );
      }),
    )
    .pipe(Effect.flatMap((selection) => awaitRecoverySelection(selection)));

export { beginPluginRecovery, ensureRunningPlugin, forkPluginRecovery };
export type { BeginRecoveryOptions, RecoveryOptions };
