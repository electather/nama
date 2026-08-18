import { Deferred, Effect, Exit } from "effect";

import { stopPlugin } from "./cleanup.ts";
import { HEALTHY_EPISODE_RESET_MILLISECONDS } from "./constants.ts";
import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import { recoverPlugin } from "./launch.ts";
import type { RecoveryPluginOptions, RecoveryResult } from "./launch.ts";
import { pluginProcessExitLog } from "./logging.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type {
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  RunningPlugin,
} from "./model.ts";

const SINGLE_LIFECYCLE_PERMIT = 1;
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
interface PluginRecoveryStart {
  readonly graceMilliseconds: number;
  readonly options: RecoveryOptions;
  readonly prior: RunningPlugin | typeof ABSENT_PLUGIN;
  readonly state: PluginHandleState;
}

interface RecoveryEpisode extends PluginRecoveryStart {
  readonly owner: symbol;
  readonly priorLaunches: number;
}

type RecoveryCompletion = Deferred.Deferred<RunningPlugin, PluginUnavailableFailure>;
type RunningPluginSelection =
  | Readonly<{ readonly completion: RecoveryCompletion; readonly kind: "recovery" }>
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
  episode: RecoveryEpisode,
  result: RecoveryResult,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  const { options, owner, state } = episode;
  return state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "recovering" || lifecycle.owner !== owner) {
        return Effect.fail(unavailable("plugin_exited"));
      }
      state.launchesInEpisode = result.launchesInEpisode;
      state.lifecycle = { kind: "ready", plugin: result.plugin };
      return forkPluginWatchers(state, options, result.plugin).pipe(Effect.as(result.plugin));
    }),
  );
};

const markPluginRecoveryFailed = (
  episode: RecoveryEpisode,
  failure: PluginUnavailableFailure,
): Effect.Effect<void> => {
  const { owner, prior, state } = episode;
  return state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.sync(() => {
      const { lifecycle } = state;
      if (lifecycle.kind === "recovering" && lifecycle.owner === owner) {
        state.lifecycle = { failure, kind: "terminal", plugin: prior };
      }
    }),
  );
};

const releaseUncommittedRecovery = (
  result: RecoveryResult,
  exit: Exit.Exit<RunningPlugin, PluginUnavailableFailure>,
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    return Effect.void;
  }
  return stopPlugin(result.plugin).pipe(Effect.orDie);
};

const recoveryProcess = (
  episode: RecoveryEpisode,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  const { graceMilliseconds, options, prior, priorLaunches } = episode;
  const { descriptor, effectiveUserId, emit, runtimeRoot, spawnProcess } = options;
  const recoveryOptions: RecoveryPluginOptions = {
    descriptor,
    effectiveUserId,
    emit,
    priorLaunches,
    runtimeRoot,
    spawnProcess,
  };
  const launch = stopPriorPlugin(prior, graceMilliseconds).pipe(
    Effect.andThen(recoverPlugin(recoveryOptions)),
  );
  return Effect.uninterruptibleMask((restore) => {
    const acquire = restore(launch);
    const use = (result: RecoveryResult) =>
      Effect.uninterruptible(markPluginRecovered(episode, result));
    return Effect.acquireUseRelease(acquire, use, releaseUncommittedRecovery).pipe(
      Effect.tapError((failure) => markPluginRecoveryFailed(episode, failure)),
    );
  });
};

const forkPluginRecovery = ({
  graceMilliseconds,
  options,
  prior,
  state,
}: PluginRecoveryStart): Effect.Effect<RecoveryCompletion> =>
  Effect.uninterruptible(
    Effect.gen(function* forkPluginRecoveryProcess() {
      const completion = yield* Deferred.make<RunningPlugin, PluginUnavailableFailure>();
      const episode: RecoveryEpisode = {
        graceMilliseconds,
        options,
        owner: Symbol("plugin-recovery"),
        prior,
        priorLaunches: state.launchesInEpisode,
        state,
      };
      const recovery = recoveryProcess(episode).pipe(
        Effect.onExit((exit) => Deferred.done(completion, exit).pipe(Effect.asVoid)),
      );
      const fiber = yield* Effect.forkDetach(recovery, { startImmediately: false });
      state.lifecycle = {
        completion,
        fiber,
        kind: "recovering",
        owner: episode.owner,
        prior,
      };
      return completion;
    }),
  );

const beginPluginRecovery = (
  state: PluginHandleState,
  options: BeginRecoveryOptions,
): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "ready" || lifecycle.plugin !== options.plugin) {
        return Effect.void;
      }
      return forkPluginRecovery({
        graceMilliseconds: options.graceMilliseconds,
        options,
        prior: lifecycle.plugin,
        state,
      }).pipe(Effect.asVoid);
    }),
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
      options.emit(pluginProcessExitLog(options.descriptor, processExit));
      return beginPluginRecovery(state, {
        ...options,
        graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
        plugin,
      });
    }),
    Effect.forkIn(state.scope, { startImmediately: false }),
    Effect.asVoid,
  );

const forkHealthyEpisodeReset = (
  state: PluginHandleState,
  plugin: RunningPlugin,
): Effect.Effect<void> => {
  const resetEpisode = state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.sync(() => {
      const { lifecycle } = state;
      if (
        lifecycle.kind === "ready" &&
        lifecycle.plugin === plugin &&
        plugin.child.exitCode === null &&
        plugin.child.signalCode === null
      ) {
        state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
      }
    }),
  );
  return Effect.sleep(HEALTHY_EPISODE_RESET_MILLISECONDS).pipe(
    Effect.andThen(resetEpisode),
    Effect.forkIn(state.scope, { startImmediately: false }),
    Effect.asVoid,
  );
};

const awaitRecoverySelection = (
  selection: RunningPluginSelection,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  if (selection.kind === "recovery") {
    return Deferred.await(selection.completion);
  }
  return Effect.succeed(selection.plugin);
};

const ensureRunningPlugin = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(
      Effect.suspend<RunningPluginSelection, PluginUnavailableFailure, never>(() => {
        const { lifecycle } = state;
        switch (lifecycle.kind) {
          case "absent": {
            return forkPluginRecovery({
              graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
              options,
              prior: ABSENT_PLUGIN,
              state,
            }).pipe(Effect.map((completion) => ({ completion, kind: "recovery" as const })));
          }
          case "closed": {
            return Effect.fail(unavailable("plugin_exited"));
          }
          case "recovering": {
            return Effect.succeed({ completion: lifecycle.completion, kind: "recovery" });
          }
          case "terminal": {
            return Effect.fail(lifecycle.failure);
          }
          case "ready": {
            if (
              lifecycle.plugin.child.exitCode === null &&
              lifecycle.plugin.child.signalCode === null
            ) {
              return Effect.succeed({ kind: "ready", plugin: lifecycle.plugin });
            }
            return forkPluginRecovery({
              graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
              options,
              prior: lifecycle.plugin,
              state,
            }).pipe(Effect.map((completion) => ({ completion, kind: "recovery" as const })));
          }
          default: {
            return lifecycle satisfies never;
          }
        }
      }),
    )
    .pipe(Effect.flatMap((selection) => awaitRecoverySelection(selection)));

export { beginPluginRecovery, ensureRunningPlugin };
export type { BeginRecoveryOptions, RecoveryOptions };
