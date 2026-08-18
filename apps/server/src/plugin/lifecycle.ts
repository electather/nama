// oxlint-disable eslint/max-lines -- Demand, recovery, and retirement transitions stay with their shared lifecycle semaphore.
import { Cause, Deferred, Effect, Exit, Fiber } from "effect";

import { cleanupOwnedResources, makeCleanupOwnership, ownCleanup, stopPlugin } from "./cleanup.ts";
import { HEALTHY_EPISODE_RESET_MILLISECONDS, PLUGIN_IDLE_GRACE_MILLISECONDS } from "./constants.ts";
import { PluginSupervisorCleanupError, unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { recoverPlugin } from "./launch.ts";
import type { RecoveryPluginOptions, RecoveryResult } from "./launch.ts";
import { pluginLifecycleMessage, pluginProcessExitLog } from "./logging.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type {
  PluginCleanupOwnership,
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  RunningPlugin,
} from "./model.ts";

const SINGLE_LIFECYCLE_PERMIT = 1;
const NO_RECOVERY_DELAY_MILLISECONDS = 0;
const NO_ACTIVE_DEMAND = 0;

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
  readonly ownership: PluginCleanupOwnership;
  readonly owner: symbol;
  readonly priorLaunches: number;
}

type RecoveryCompletion = Deferred.Deferred<RunningPlugin, PluginUnavailableFailure>;
type RetirementCompletion = Deferred.Deferred<void, PluginUnavailableFailure>;
type RunningPluginSelection =
  | Readonly<{ readonly completion: RecoveryCompletion; readonly kind: "recovery" }>
  | Readonly<{ readonly kind: "ready"; readonly plugin: RunningPlugin }>
  | Readonly<{ readonly completion: RetirementCompletion; readonly kind: "retirement" }>;

interface IdleRetirement {
  readonly completion: RetirementCompletion;
  readonly options: RecoveryOptions;
  readonly owner: symbol;
  readonly ownership: PluginCleanupOwnership;
  readonly state: PluginHandleState;
}

interface IdleRetirementCommit {
  readonly cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>;
  readonly options: RecoveryOptions;
  readonly ownership: PluginCleanupOwnership;
  readonly state: PluginHandleState;
}

const interruptPluginRecovery = (
  fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Fiber.interrupt(fiber).pipe(
    Effect.andThen(Fiber.await(fiber)),
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
        return Effect.fail(new PluginSupervisorCleanupError());
      }
      return Effect.void;
    }),
  );

const stopPluginRecovery = (
  fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>,
  ownership: PluginCleanupOwnership,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.gen(function* stopRecoveryAndOwnedResources() {
    const recoveryExit = yield* interruptPluginRecovery(fiber).pipe(Effect.exit);
    if (Exit.isFailure(recoveryExit)) {
      return yield* Effect.failCause(recoveryExit.cause);
    }
    return yield* cleanupOwnedResources(ownership);
  });
type PluginHandleCloseSelection =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{
      readonly cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>;
      readonly kind: "cleanup";
    }>
  | Readonly<{
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovery";
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{
      readonly fiber: Fiber.Fiber<void>;
      readonly kind: "retirement";
      readonly ownership: PluginCleanupOwnership;
    }>;

interface PluginHandleClosure {
  readonly idleTimer: Fiber.Fiber<void> | undefined;
  readonly selection: PluginHandleCloseSelection;
}

const selectTerminalPluginClose = (
  plugin: RunningPlugin | typeof ABSENT_PLUGIN,
): PluginHandleCloseSelection => {
  if (plugin === ABSENT_PLUGIN) {
    return { kind: "none" };
  }
  return { cleanup: stopPlugin(plugin), kind: "cleanup" };
};

const closeSelectionForLifecycle = (
  lifecycle: PluginHandleState["lifecycle"],
): PluginHandleCloseSelection => {
  switch (lifecycle.kind) {
    case "absent":
    case "closed": {
      return { kind: "none" };
    }
    case "ready": {
      return { cleanup: stopPlugin(lifecycle.plugin), kind: "cleanup" };
    }
    case "recovering": {
      return {
        fiber: lifecycle.fiber,
        kind: "recovery",
        ownership: lifecycle.ownership,
      };
    }
    case "retiring": {
      return {
        fiber: lifecycle.fiber,
        kind: "retirement",
        ownership: lifecycle.ownership,
      };
    }
    case "retirement_failed": {
      return { cleanup: cleanupOwnedResources(lifecycle.ownership), kind: "cleanup" };
    }
    case "terminal": {
      return selectTerminalPluginClose(lifecycle.plugin);
    }
    default: {
      return lifecycle satisfies never;
    }
  }
};

const selectPluginHandleClose = (state: PluginHandleState): PluginHandleClosure => {
  const { lifecycle } = state;
  const idleTimer = state.idleTimer?.fiber;
  state.idleTimer = undefined;
  state.lifecycle = { kind: "closed" };
  return { idleTimer, selection: closeSelectionForLifecycle(lifecycle) };
};

const closeSelectedPlugin = (
  selection: PluginHandleCloseSelection,
): Effect.Effect<void, PluginSupervisorCleanupFailure> => {
  switch (selection.kind) {
    case "none": {
      return Effect.void;
    }
    case "cleanup": {
      return selection.cleanup;
    }
    case "recovery": {
      return stopPluginRecovery(selection.fiber, selection.ownership);
    }
    case "retirement": {
      return Fiber.join(selection.fiber).pipe(
        Effect.andThen(cleanupOwnedResources(selection.ownership)),
      );
    }
    default: {
      return selection satisfies never;
    }
  }
};

const closePluginHandle = (
  state: PluginHandleState,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(Effect.sync(() => selectPluginHandleClose(state)))
    .pipe(
      Effect.flatMap(({ idleTimer, selection }) => {
        const close = closeSelectedPlugin(selection);
        if (idleTimer === undefined) {
          return close;
        }
        return Fiber.interrupt(idleTimer).pipe(Effect.asVoid, Effect.andThen(close));
      }),
    );

const completeIdlePluginRetirement = ({
  completion,
  options,
  state,
}: IdleRetirement): Effect.Effect<void> => {
  state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
  state.lifecycle = { kind: "absent" };
  options.emit(
    Effect.logDebug(pluginLifecycleMessage(options.descriptor, "plugin.process_idle_stopped")),
  );
  return Deferred.done(completion, Exit.void).pipe(Effect.asVoid);
};

const failIdlePluginRetirement = ({
  completion,
  options,
  ownership,
  state,
}: IdleRetirement): Effect.Effect<void> => {
  const failure = unavailable("plugin_exited");
  state.lifecycle = { failure, kind: "retirement_failed", ownership };
  options.emit(
    Effect.logError(pluginLifecycleMessage(options.descriptor, "plugin.process_idle_stop_failed")),
  );
  return Deferred.fail(completion, failure).pipe(Effect.asVoid);
};

// fallow-ignore-next-line code-duplication -- Retirement completion and recovery acquisition preserve distinct ownership transitions.
const finishIdlePluginRetirement = (
  retirement: IdleRetirement,
  exit: Exit.Exit<void, PluginSupervisorCleanupFailure>,
): Effect.Effect<void> =>
  retirement.state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.uninterruptible(
      Effect.suspend(() => {
        const { lifecycle } = retirement.state;
        if (lifecycle.kind !== "retiring" || lifecycle.owner !== retirement.owner) {
          return Effect.void;
        }
        if (Exit.isSuccess(exit)) {
          return completeIdlePluginRetirement(retirement);
        }
        return failIdlePluginRetirement(retirement);
      }),
    ),
  );

const commitIdleRetirement = ({
  cleanup,
  options,
  ownership,
  state,
}: IdleRetirementCommit): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.gen(function* commitRetirement() {
      const completion = yield* Deferred.make<void, PluginUnavailableFailure>();
      const owner = Symbol("plugin-retirement");
      const retirementState: IdleRetirement = {
        completion,
        options,
        owner,
        ownership,
        state,
      };
      const retirement = cleanup.pipe(
        Effect.exit,
        Effect.flatMap((exit) => finishIdlePluginRetirement(retirementState, exit)),
      );
      const fiber = yield* Effect.forkDetach(retirement, { startImmediately: false });
      state.idleTimer = undefined;
      state.lifecycle = { completion, fiber, kind: "retiring", owner, ownership };
    }),
  );

const ownsExpiredIdleTimer = (state: PluginHandleState, owner: symbol): boolean =>
  state.activeDemand === NO_ACTIVE_DEMAND && state.idleTimer?.owner === owner;

type CommittedPluginRetirement = Extract<
  PluginHandleState["lifecycle"],
  { readonly kind: "retiring" } | { readonly kind: "retirement_failed" }
>;

const retirementAlreadyCommitted = (
  lifecycle: PluginHandleState["lifecycle"],
): lifecycle is CommittedPluginRetirement =>
  lifecycle.kind === "retiring" || lifecycle.kind === "retirement_failed";

const retireIdlePlugin = (
  state: PluginHandleState,
  owner: symbol,
  options: RecoveryOptions,
): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    // oxlint-disable-next-line eslint/max-statements -- Retirement validates timer ownership and commits one lifecycle transition.
    Effect.suspend(() => {
      if (!ownsExpiredIdleTimer(state, owner)) {
        return Effect.void;
      }
      const { lifecycle } = state;
      if (lifecycle.kind === "closed") {
        state.idleTimer = undefined;
        return Effect.void;
      }
      if (retirementAlreadyCommitted(lifecycle)) {
        return Effect.void;
      }
      if (lifecycle.kind === "recovering") {
        const cleanup = stopPluginRecovery(lifecycle.fiber, lifecycle.ownership);
        return commitIdleRetirement({
          cleanup,
          options,
          ownership: lifecycle.ownership,
          state,
        });
      }
      const resetLifecycle = Effect.sync(() => {
        state.idleTimer = undefined;
        state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
        state.lifecycle = { kind: "absent" };
      });
      if (lifecycle.kind === "absent" || lifecycle.plugin === ABSENT_PLUGIN) {
        return resetLifecycle;
      }
      const ownership = makeCleanupOwnership();
      ownCleanup(ownership, stopPlugin(lifecycle.plugin));
      return commitIdleRetirement({
        cleanup: cleanupOwnedResources(ownership),
        options,
        ownership,
        state,
      });
    }),
  );

const startPluginIdleTimer = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<void> =>
  Effect.gen(function* startIdleTimer() {
    const owner = Symbol("plugin-idle-timer");
    const retirement = Effect.sleep(PLUGIN_IDLE_GRACE_MILLISECONDS).pipe(
      Effect.andThen(retireIdlePlugin(state, owner, options)),
    );
    const fiber = yield* Effect.forkIn(retirement, state.scope, {
      startImmediately: false,
    });
    state.idleTimer = { fiber, owner };
  });

const acquirePluginDemand = (
  state: PluginHandleState,
): Effect.Effect<void, PluginUnavailableFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(
      Effect.suspend(() => {
        if (state.lifecycle.kind === "closed") {
          return Effect.fail(unavailable("plugin_exited"));
        }
        state.activeDemand += 1;
        const { idleTimer } = state;
        state.idleTimer = undefined;
        return Effect.succeed(idleTimer);
      }),
    )
    .pipe(
      Effect.flatMap((idleTimer) => {
        if (idleTimer === undefined) {
          return Effect.void;
        }
        return Fiber.interrupt(idleTimer.fiber).pipe(Effect.asVoid);
      }),
    );

const releasePluginDemand = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.gen(function* releaseDemand() {
      if (state.activeDemand === NO_ACTIVE_DEMAND) {
        yield* Effect.die("plugin demand underflow");
      }
      state.activeDemand -= 1;
      if (
        state.activeDemand === NO_ACTIVE_DEMAND &&
        state.lifecycle.kind !== "closed" &&
        state.lifecycle.kind !== "retiring" &&
        state.lifecycle.kind !== "retirement_failed"
      ) {
        yield* startPluginIdleTimer(state, options);
      }
    }),
  );

const withPluginDemand = <Success, Failure, Requirements>(
  state: PluginHandleState,
  options: RecoveryOptions,
  operation: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | PluginUnavailableFailure, Requirements> =>
  Effect.acquireUseRelease(
    acquirePluginDemand(state),
    () => operation,
    () => releasePluginDemand(state, options),
  );

const stopPriorPlugin = (
  ownership: PluginCleanupOwnership,
  graceMilliseconds: number,
): Effect.Effect<void, PluginUnavailableFailure> => {
  if (ownership.target === undefined) {
    return Effect.void;
  }
  return Effect.sleep(graceMilliseconds).pipe(
    Effect.andThen(cleanupOwnedResources(ownership)),
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
  const { owner, ownership, prior, state } = episode;
  return state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.sync(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "recovering" || lifecycle.owner !== owner) {
        return;
      }
      if (ownership.target === undefined) {
        state.lifecycle = { failure, kind: "terminal", plugin: prior };
        return;
      }
      state.lifecycle = { failure, kind: "retirement_failed", ownership };
    }),
  );
};

const releaseUncommittedRecovery = (
  ownership: PluginCleanupOwnership,
  exit: Exit.Exit<RunningPlugin, PluginUnavailableFailure>,
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) {
    return Effect.void;
  }
  return cleanupOwnedResources(ownership).pipe(Effect.orDie);
};

const recoveryProcess = (
  episode: RecoveryEpisode,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  const { graceMilliseconds, options, ownership, priorLaunches } = episode;
  const { descriptor, effectiveUserId, emit, runtimeRoot, spawnProcess } = options;
  const recoveryOptions: RecoveryPluginOptions = {
    descriptor,
    effectiveUserId,
    emit,
    ownership,
    priorLaunches,
    runtimeRoot,
    spawnProcess,
  };
  const launch = stopPriorPlugin(ownership, graceMilliseconds).pipe(
    Effect.andThen(recoverPlugin(recoveryOptions)),
  );
  return Effect.uninterruptibleMask((restore) => {
    const acquire = restore(launch);
    const use = (result: RecoveryResult) =>
      Effect.uninterruptible(markPluginRecovered(episode, result));
    return Effect.acquireUseRelease(acquire, use, (_result, exit) =>
      releaseUncommittedRecovery(ownership, exit),
    ).pipe(Effect.tapError((failure) => markPluginRecoveryFailed(episode, failure)));
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
      const ownership = makeCleanupOwnership();
      if (prior !== ABSENT_PLUGIN) {
        ownCleanup(ownership, stopPlugin(prior));
      }
      const episode: RecoveryEpisode = {
        graceMilliseconds,
        options,
        owner: Symbol("plugin-recovery"),
        ownership,
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
        ownership,
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

const handleUnexpectedPluginExit = (
  state: PluginHandleState,
  options: RecoveryOptions,
  plugin: RunningPlugin,
): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "ready" || lifecycle.plugin !== plugin) {
        return Effect.void;
      }
      if (state.activeDemand !== NO_ACTIVE_DEMAND) {
        return forkPluginRecovery({
          graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
          options,
          prior: plugin,
          state,
        }).pipe(Effect.asVoid);
      }
      return stopPlugin(plugin).pipe(
        Effect.andThen(
          Effect.sync(() => {
            state.lifecycle = { kind: "absent" };
          }),
        ),
        Effect.orDie,
      );
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
      return handleUnexpectedPluginExit(state, options, plugin);
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

const awaitRunningPluginSelection = (
  selection: RunningPluginSelection,
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  if (selection.kind === "recovery") {
    return Deferred.await(selection.completion);
  }
  if (selection.kind === "retirement") {
    return Deferred.await(selection.completion).pipe(
      Effect.andThen(Effect.suspend(() => ensureRunningPlugin(state, options))),
    );
  }
  return Effect.succeed(selection.plugin);
};

const selectReadyPlugin = (
  state: PluginHandleState,
  options: RecoveryOptions,
  plugin: RunningPlugin,
): Effect.Effect<RunningPluginSelection> => {
  if (plugin.child.exitCode === null && plugin.child.signalCode === null) {
    return Effect.succeed({ kind: "ready", plugin });
  }
  return forkPluginRecovery({
    graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
    options,
    prior: plugin,
    state,
  }).pipe(Effect.map((completion) => ({ completion, kind: "recovery" as const })));
};

const selectRunningPlugin = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<RunningPluginSelection, PluginUnavailableFailure> =>
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
      case "retiring": {
        return Effect.succeed({ completion: lifecycle.completion, kind: "retirement" });
      }
      case "retirement_failed":
      case "terminal": {
        return Effect.fail(lifecycle.failure);
      }
      case "ready": {
        return selectReadyPlugin(state, options, lifecycle.plugin);
      }
      default: {
        return lifecycle satisfies never;
      }
    }
  });

const ensureRunningPlugin = (
  state: PluginHandleState,
  options: RecoveryOptions,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(selectRunningPlugin(state, options))
    .pipe(Effect.flatMap((selection) => awaitRunningPluginSelection(selection, state, options)));

export { beginPluginRecovery, closePluginHandle, ensureRunningPlugin, withPluginDemand };
export type { BeginRecoveryOptions, RecoveryOptions };
