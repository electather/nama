// oxlint-disable eslint/max-lines -- One serialized state machine owns admission, demand, recovery, retirement, cleanup, and finalization transitions.
import { Cause, Deferred, Effect, Exit, Fiber, Semaphore } from "effect";
import type { Scope } from "effect";

import { stopPlugin } from "./cleanup.ts";
import {
  HEALTHY_EPISODE_RESET_MILLISECONDS,
  PLUGIN_IDLE_GRACE_MILLISECONDS,
  RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS,
} from "./constants.ts";
import { PluginSupervisorCleanupError, unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { recoverPlugin } from "./launch.ts";
import type { RecoveryPluginOptions, RecoveryResult } from "./launch.ts";
import { pluginLifecycleMessage, pluginProcessExitLog } from "./logging.ts";
import type {
  PreparedPluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  RunningPlugin,
} from "./model.ts";

const SINGLE_LIFECYCLE_PERMIT = 1;
const NO_RECOVERY_DELAY_MILLISECONDS = 0;
const NO_ACTIVE_DEMAND = 0;
const COMPLETED_PLUGIN_RETIREMENT = Symbol("completed-plugin-retirement");
const ABSENT_PLUGIN = Symbol("absent-plugin");
interface PluginCleanupTarget {
  readonly cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>;
  readonly owner: symbol;
}

interface PluginCleanupOwnership {
  target: PluginCleanupTarget | undefined;
}

type PluginLifecycleState =
  | Readonly<{ readonly kind: "absent" }>
  | Readonly<{ readonly kind: "closed" }>
  | Readonly<{
      readonly completion: Deferred.Deferred<RunningPlugin, PluginUnavailableFailure>;
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovering";
      readonly owner: symbol;
      readonly ownership: PluginCleanupOwnership;
      readonly prior: RunningPlugin | typeof ABSENT_PLUGIN;
    }>
  | Readonly<{
      readonly completion: Deferred.Deferred<void, PluginUnavailableFailure>;
      readonly fiber: Fiber.Fiber<void>;
      readonly kind: "retiring";
      readonly owner: symbol;
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{
      readonly failure: PluginUnavailableFailure;
      readonly kind: "retirement_failed";
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{ readonly kind: "ready"; readonly plugin: RunningPlugin }>
  | Readonly<{
      readonly failure: PluginUnavailableFailure;
      readonly kind: "terminal";
      readonly plugin: RunningPlugin | typeof ABSENT_PLUGIN;
    }>;

interface PluginHandleState {
  admission:
    | Readonly<{ readonly kind: "open" }>
    | Readonly<{
        readonly drained: Deferred.Deferred<void>;
        readonly kind: "closed";
      }>;
  activeDemand: number;
  idleTimer:
    | Readonly<{
        readonly fiber: Fiber.Fiber<void>;
        readonly owner: symbol;
      }>
    | undefined;
  launchesInEpisode: number;
  resetRecoveryEpisodeAfterRetirement: boolean;
  lifecycle: PluginLifecycleState;
  readonly lifecycleSemaphore: Semaphore.Semaphore;
  readonly options: RecoveryOptions;
  readonly scope: Scope.Scope;
}

interface PluginLifecycleOptions {
  readonly descriptor: PluginLaunchDescriptor;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly launch: PreparedPluginLaunch;
  readonly runtimeRoot: string;
  readonly scope: Scope.Scope;
  readonly spawnProcess: PluginSpawnProcess;
}

type RecoveryOptions = Omit<PluginLifecycleOptions, "scope">;

type PluginRecoveryReason = "plugin_exited" | "rpc_deadline_exceeded";

interface BeginRecoveryOptions {
  readonly graceMilliseconds: number;
  readonly plugin: RunningPlugin;
}
interface PluginRecoveryStart {
  readonly graceMilliseconds: number;
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

interface PluginAdmissionFence {
  readonly drained: Deferred.Deferred<void>;
  readonly idleTimer?: Exclude<PluginHandleState["idleTimer"], undefined>;
}
const makePluginAdmissionFence = (
  drained: Deferred.Deferred<void>,
  idleTimer: PluginHandleState["idleTimer"],
): PluginAdmissionFence => {
  if (idleTimer === undefined) {
    return { drained };
  }
  return { drained, idleTimer };
};
const makeCleanupOwnership = (): PluginCleanupOwnership => ({ target: undefined });

const clearOwnedCleanup = (ownership: PluginCleanupOwnership, owner: symbol): Effect.Effect<void> =>
  Effect.sync(() => {
    if (ownership.target?.owner === owner) {
      ownership.target = undefined;
    }
  });

const ownCleanup = (
  ownership: PluginCleanupOwnership,
  cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>,
): void => {
  const owner = Symbol("plugin-cleanup");
  const target: PluginCleanupTarget = {
    cleanup: cleanup.pipe(Effect.tap(() => clearOwnedCleanup(ownership, owner))),
    owner,
  };
  ownership.target = target;
};

const cleanupOwnedResources = (
  ownership: PluginCleanupOwnership,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.suspend(() => ownership.target?.cleanup ?? Effect.void);

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
      readonly ownership: PluginCleanupOwnership;
    }>
  | Readonly<{
      readonly completion: RetirementCompletion;
      readonly kind: "committed";
    }>;

const ownedPluginClose = (
  plugin: RunningPlugin | typeof ABSENT_PLUGIN,
): PluginHandleCloseSelection => {
  if (plugin === ABSENT_PLUGIN) {
    return { kind: "none" };
  }
  const ownership = makeCleanupOwnership();
  ownCleanup(ownership, stopPlugin(plugin));
  return { cleanup: cleanupOwnedResources(ownership), kind: "cleanup", ownership };
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
      return ownedPluginClose(lifecycle.plugin);
    }
    case "recovering": {
      return {
        cleanup: stopPluginRecovery(lifecycle.fiber, lifecycle.ownership),
        kind: "cleanup",
        ownership: lifecycle.ownership,
      };
    }
    case "retiring": {
      return { completion: lifecycle.completion, kind: "committed" };
    }
    case "retirement_failed": {
      return {
        cleanup: cleanupOwnedResources(lifecycle.ownership),
        kind: "cleanup",
        ownership: lifecycle.ownership,
      };
    }
    case "terminal": {
      return ownedPluginClose(lifecycle.plugin);
    }
    default: {
      return lifecycle satisfies never;
    }
  }
};

type PluginRetirementKind = "close" | "idle" | "unexpected_idle_exit";

interface PluginRetirement {
  readonly completion: RetirementCompletion;
  readonly kind: PluginRetirementKind;
  readonly owner: symbol;
  readonly ownership: PluginCleanupOwnership;
  readonly state: PluginHandleState;
}
interface PluginRetirementCommit {
  readonly cleanup: Effect.Effect<void, PluginSupervisorCleanupFailure>;
  readonly kind: PluginRetirementKind;
  readonly ownership: PluginCleanupOwnership;
  readonly state: PluginHandleState;
}
interface PluginCloseRetirement {
  readonly completion: RetirementCompletion | typeof COMPLETED_PLUGIN_RETIREMENT;
  readonly joined: boolean;
}

const commitRetirementLifecycle = (retirement: PluginRetirement): void => {
  if (retirement.kind === "close") {
    retirement.state.lifecycle = { kind: "closed" };
    return;
  }
  retirement.state.lifecycle = { kind: "absent" };
};

const completePluginRetirement = (retirement: PluginRetirement): Effect.Effect<void> => {
  if (retirement.kind === "idle" || retirement.state.resetRecoveryEpisodeAfterRetirement) {
    retirement.state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
    retirement.state.resetRecoveryEpisodeAfterRetirement = false;
  }
  const complete = Deferred.done(retirement.completion, Exit.void).pipe(Effect.asVoid);
  commitRetirementLifecycle(retirement);
  if (retirement.kind !== "idle") {
    return complete;
  }
  const { options } = retirement.state;
  return Effect.logDebug(
    pluginLifecycleMessage(
      { descriptor: options.descriptor, launch: options.launch },
      "plugin.process_idle_stopped",
    ),
  ).pipe(Effect.andThen(complete));
};

const failPluginRetirement = (retirement: PluginRetirement): Effect.Effect<void> => {
  const failure = unavailable("plugin_exited");
  retirement.state.lifecycle = {
    failure,
    kind: "retirement_failed",
    ownership: retirement.ownership,
  };
  const complete = Deferred.fail(retirement.completion, failure).pipe(Effect.asVoid);
  if (retirement.kind === "close") {
    return complete;
  }
  const { options } = retirement.state;
  return Effect.logError(
    pluginLifecycleMessage(
      { descriptor: options.descriptor, launch: options.launch },
      "plugin.process_idle_stop_failed",
    ),
  ).pipe(Effect.andThen(complete));
};

const finishPluginRetirement = (
  retirement: PluginRetirement,
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
          return completePluginRetirement(retirement);
        }
        return failPluginRetirement(retirement);
      }),
    ),
  );

const commitPluginRetirement = ({
  cleanup,
  kind,
  ownership,
  state,
}: PluginRetirementCommit): Effect.Effect<RetirementCompletion> =>
  Effect.uninterruptible(
    Effect.gen(function* commitRetirement() {
      const completion = yield* Deferred.make<void, PluginUnavailableFailure>();
      const owner = Symbol("plugin-retirement");
      const retirementState: PluginRetirement = {
        completion,
        kind,
        owner,
        ownership,
        state,
      };
      const retirement = cleanup.pipe(
        Effect.exit,
        Effect.flatMap((exit) => finishPluginRetirement(retirementState, exit)),
      );
      const fiber = yield* Effect.forkDetach(retirement, { startImmediately: false });
      if (kind === "idle") {
        state.idleTimer = undefined;
      }
      state.lifecycle = { completion, fiber, kind: "retiring", owner, ownership };
      return completion;
    }),
  );

const startPluginCloseRetirement = (
  state: PluginHandleState,
): Effect.Effect<PluginCloseRetirement> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend<PluginCloseRetirement, never, never>(() => {
      const selection = closeSelectionForLifecycle(state.lifecycle);
      if (selection.kind === "none") {
        state.lifecycle = { kind: "closed" };
        return Effect.succeed({
          completion: COMPLETED_PLUGIN_RETIREMENT,
          joined: false,
        });
      }
      if (selection.kind === "committed") {
        return Effect.succeed({ completion: selection.completion, joined: true });
      }
      return commitPluginRetirement({
        cleanup: selection.cleanup,
        kind: "close",
        ownership: selection.ownership,
        state,
      }).pipe(Effect.map((completion) => ({ completion, joined: false })));
    }),
  );

const awaitPluginCloseRetirement = (
  completion: RetirementCompletion | typeof COMPLETED_PLUGIN_RETIREMENT,
): Effect.Effect<void, PluginSupervisorCleanupFailure> => {
  if (completion === COMPLETED_PLUGIN_RETIREMENT) {
    return Effect.void;
  }
  return Deferred.await(completion).pipe(Effect.mapError(() => new PluginSupervisorCleanupError()));
};

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

const retireIdlePlugin = (state: PluginHandleState, owner: symbol): Effect.Effect<void> =>
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
        state.idleTimer = undefined;
        state.resetRecoveryEpisodeAfterRetirement = true;
        return Effect.void;
      }
      if (lifecycle.kind === "recovering") {
        const cleanup = stopPluginRecovery(lifecycle.fiber, lifecycle.ownership);
        return commitPluginRetirement({
          cleanup,
          kind: "idle",
          ownership: lifecycle.ownership,
          state,
        }).pipe(Effect.asVoid);
      }
      const resetLifecycle = Effect.sync(() => {
        state.idleTimer = undefined;
        state.launchesInEpisode = NO_RECOVERY_DELAY_MILLISECONDS;
        state.resetRecoveryEpisodeAfterRetirement = false;
        state.lifecycle = { kind: "absent" };
      });
      if (lifecycle.kind === "absent" || lifecycle.plugin === ABSENT_PLUGIN) {
        return resetLifecycle;
      }
      const ownership = makeCleanupOwnership();
      ownCleanup(ownership, stopPlugin(lifecycle.plugin));
      return commitPluginRetirement({
        cleanup: cleanupOwnedResources(ownership),
        kind: "idle",
        ownership,
        state,
      }).pipe(Effect.asVoid);
    }),
  );

const startPluginIdleTimer = (state: PluginHandleState): Effect.Effect<void> =>
  Effect.gen(function* startIdleTimer() {
    const owner = Symbol("plugin-idle-timer");
    const retirement = Effect.sleep(PLUGIN_IDLE_GRACE_MILLISECONDS).pipe(
      Effect.andThen(retireIdlePlugin(state, owner)),
    );
    const fiber = yield* Effect.forkIn(retirement, state.scope, {
      startImmediately: false,
    });
    state.idleTimer = { fiber, owner };
  });
const fencePluginAdmission = (state: PluginHandleState): Effect.Effect<PluginAdmissionFence> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.gen(function* fenceAdmission() {
      if (state.admission.kind === "closed") {
        return { drained: state.admission.drained };
      }
      const drained = yield* Deferred.make<void>();
      const { idleTimer } = state;
      state.admission = { drained, kind: "closed" };
      state.idleTimer = undefined;
      if (state.activeDemand === NO_ACTIVE_DEMAND) {
        yield* Deferred.done(drained, Exit.void);
      }
      return makePluginAdmissionFence(drained, idleTimer);
    }),
  );

const startPluginRetirement = (state: PluginHandleState): Effect.Effect<PluginCloseRetirement> =>
  Effect.uninterruptible(
    fencePluginAdmission(state).pipe(
      Effect.flatMap(({ drained, idleTimer }) => {
        let stopIdleTimer = Effect.void;
        if (idleTimer !== undefined) {
          stopIdleTimer = Fiber.interrupt(idleTimer.fiber).pipe(Effect.asVoid);
        }
        return stopIdleTimer.pipe(
          Effect.andThen(Deferred.await(drained)),
          Effect.andThen(startPluginCloseRetirement(state)),
        );
      }),
    ),
  );
const beginPluginRetirement = (state: PluginHandleState): Effect.Effect<void> =>
  startPluginRetirement(state).pipe(Effect.asVoid);

const retirePluginHandle = (
  state: PluginHandleState,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.uninterruptibleMask((restore) =>
    startPluginRetirement(state).pipe(
      Effect.flatMap((retirement) =>
        restore(
          awaitPluginCloseRetirement(retirement.completion).pipe(
            Effect.matchEffect({
              onFailure: (error) => {
                if (!retirement.joined) {
                  return Effect.fail(error);
                }
                return startPluginCloseRetirement(state).pipe(
                  Effect.flatMap((retry) => awaitPluginCloseRetirement(retry.completion)),
                );
              },
              onSuccess: () => Effect.void,
            }),
          ),
        ),
      ),
    ),
  );
const restorePluginCallExit = <Success, Failure>(
  exit: Exit.Exit<Success, Failure>,
): Effect.Effect<Success, Failure> => {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed(exit.value);
  }
  return Effect.failCause(exit.cause);
};

const withCandidateRetirement = <Success, Failure, Requirements>(
  state: PluginHandleState,
  operation: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | PluginUnavailableFailure, Requirements> =>
  Effect.exit(operation).pipe(
    Effect.flatMap((exit) =>
      retirePluginHandle(state).pipe(
        Effect.mapError(() => unavailable("plugin_exited")),
        Effect.andThen(restorePluginCallExit(exit)),
      ),
    ),
    Effect.onInterrupt(() => beginPluginRetirement(state)),
  );

const acquirePluginDemand = (
  state: PluginHandleState,
): Effect.Effect<void, PluginUnavailableFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(
      Effect.suspend(() => {
        if (state.admission.kind === "closed" || state.lifecycle.kind === "closed") {
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

const releasePluginDemand = (state: PluginHandleState): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.gen(function* releaseDemand() {
      if (state.activeDemand === NO_ACTIVE_DEMAND) {
        yield* Effect.die("plugin demand underflow");
      }
      state.activeDemand -= 1;
      if (state.activeDemand !== NO_ACTIVE_DEMAND) {
        return;
      }
      if (state.admission.kind === "closed") {
        yield* Deferred.done(state.admission.drained, Exit.void);
        return;
      }
      if (
        state.lifecycle.kind !== "closed" &&
        state.lifecycle.kind !== "retiring" &&
        state.lifecycle.kind !== "retirement_failed"
      ) {
        yield* startPluginIdleTimer(state);
      }
    }),
  );

const withPluginDemand = <Success, Failure, Requirements>(
  state: PluginHandleState,
  operation: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | PluginUnavailableFailure, Requirements> =>
  Effect.acquireUseRelease(
    acquirePluginDemand(state),
    () => operation,
    () => releasePluginDemand(state),
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
  plugin: RunningPlugin,
): Effect.Effect<void> => {
  const exitWatcher = forkPluginExitWatcher(state, plugin);
  const episodeReset = forkHealthyEpisodeReset(state, plugin);
  return Effect.all([exitWatcher, episodeReset], { concurrency: "unbounded", discard: true });
};

const markPluginRecovered = (
  episode: RecoveryEpisode,
  result: RecoveryResult,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  const { owner, state } = episode;
  return state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "recovering" || lifecycle.owner !== owner) {
        return Effect.fail(unavailable("plugin_exited"));
      }
      state.launchesInEpisode = result.launchesInEpisode;
      state.lifecycle = { kind: "ready", plugin: result.plugin };
      return forkPluginWatchers(state, result.plugin).pipe(Effect.as(result.plugin));
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
  const { graceMilliseconds, ownership, priorLaunches, state } = episode;
  const { descriptor, effectiveUserId, emit, launch, runtimeRoot, spawnProcess } = state.options;
  const recoveryOptions: RecoveryPluginOptions = {
    cleanup: {
      own: (cleanup) => {
        ownCleanup(ownership, cleanup);
      },
      release: cleanupOwnedResources(ownership),
    },
    descriptor,
    effectiveUserId,
    emit,
    launch,
    priorLaunches,
    runtimeRoot,
    spawnProcess,
  };
  const recoveryLaunch = stopPriorPlugin(ownership, graceMilliseconds).pipe(
    Effect.andThen(recoverPlugin(recoveryOptions)),
  );
  return Effect.uninterruptibleMask((restore) => {
    const acquire = restore(recoveryLaunch);
    const use = (result: RecoveryResult) =>
      Effect.uninterruptible(markPluginRecovered(episode, result));
    return Effect.acquireUseRelease(acquire, use, (_result, exit) =>
      releaseUncommittedRecovery(ownership, exit),
    ).pipe(Effect.tapError((failure) => markPluginRecoveryFailed(episode, failure)));
  });
};

const forkPluginRecovery = ({
  graceMilliseconds,
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
  recovery: BeginRecoveryOptions,
): Effect.Effect<void> =>
  state.lifecycleSemaphore.withPermits(SINGLE_LIFECYCLE_PERMIT)(
    Effect.suspend(() => {
      const { lifecycle } = state;
      if (lifecycle.kind !== "ready" || lifecycle.plugin !== recovery.plugin) {
        return Effect.void;
      }
      return forkPluginRecovery({
        graceMilliseconds: recovery.graceMilliseconds,
        prior: lifecycle.plugin,
        state,
      }).pipe(Effect.asVoid);
    }),
  );

const recoverPluginAfterCall = (
  state: PluginHandleState,
  plugin: RunningPlugin,
  reason: PluginRecoveryReason,
): Effect.Effect<void> => {
  const { options } = state;
  if (reason === "plugin_exited") {
    plugin.stop.unexpectedExit = true;
  }
  if (options.launch.kind === "candidate") {
    return Effect.void;
  }
  if (reason !== "rpc_deadline_exceeded") {
    return beginPluginRecovery(state, {
      graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
      plugin,
    });
  }
  return Effect.logWarning(
    pluginLifecycleMessage(
      { descriptor: options.descriptor, launch: options.launch },
      "plugin.rpc_deadline_exceeded",
    ),
  ).pipe(
    Effect.andThen(
      beginPluginRecovery(state, {
        graceMilliseconds: RPC_TIMEOUT_RECOVERY_GRACE_MILLISECONDS,
        plugin,
      }),
    ),
  );
};

const handleUnexpectedPluginExit = (
  state: PluginHandleState,
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
          prior: plugin,
          state,
        }).pipe(Effect.asVoid);
      }
      const ownership = makeCleanupOwnership();
      ownCleanup(ownership, stopPlugin(plugin));
      return commitPluginRetirement({
        cleanup: cleanupOwnedResources(ownership),
        kind: "unexpected_idle_exit",
        ownership,
        state,
      }).pipe(Effect.asVoid);
    }),
  );

const forkPluginExitWatcher = (
  state: PluginHandleState,
  plugin: RunningPlugin,
): Effect.Effect<void> =>
  Effect.promise(() => plugin.exit).pipe(
    Effect.flatMap((processExit) => {
      if (processExit.requestedStop) {
        return Effect.void;
      }
      const { options } = state;
      return pluginProcessExitLog(
        { descriptor: options.descriptor, launch: options.launch },
        processExit,
      ).pipe(Effect.andThen(handleUnexpectedPluginExit(state, plugin)));
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
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> => {
  if (selection.kind === "recovery") {
    return Deferred.await(selection.completion);
  }
  if (selection.kind === "retirement") {
    return Deferred.await(selection.completion).pipe(
      Effect.andThen(Effect.suspend(() => ensureRunningPlugin(state))),
    );
  }
  return Effect.succeed(selection.plugin);
};

const selectReadyPlugin = (
  state: PluginHandleState,
  plugin: RunningPlugin,
): Effect.Effect<RunningPluginSelection> => {
  if (plugin.child.exitCode === null && plugin.child.signalCode === null) {
    return Effect.succeed({ kind: "ready", plugin });
  }
  return forkPluginRecovery({
    graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
    prior: plugin,
    state,
  }).pipe(Effect.map((completion) => ({ completion, kind: "recovery" as const })));
};

const selectRunningPlugin = (
  state: PluginHandleState,
): Effect.Effect<RunningPluginSelection, PluginUnavailableFailure> =>
  Effect.suspend<RunningPluginSelection, PluginUnavailableFailure, never>(() => {
    const { lifecycle } = state;
    switch (lifecycle.kind) {
      case "absent": {
        return forkPluginRecovery({
          graceMilliseconds: NO_RECOVERY_DELAY_MILLISECONDS,
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
        return selectReadyPlugin(state, lifecycle.plugin);
      }
      default: {
        return lifecycle satisfies never;
      }
    }
  });

const ensureRunningPlugin = (
  state: PluginHandleState,
): Effect.Effect<RunningPlugin, PluginUnavailableFailure> =>
  state.lifecycleSemaphore
    .withPermits(SINGLE_LIFECYCLE_PERMIT)(selectRunningPlugin(state))
    .pipe(Effect.flatMap((selection) => awaitRunningPluginSelection(selection, state)));

class PluginLifecycleHandle {
  readonly #state: PluginHandleState;

  private constructor({ scope, ...options }: PluginLifecycleOptions) {
    this.#state = {
      activeDemand: NO_ACTIVE_DEMAND,
      admission: { kind: "open" },
      idleTimer: undefined,
      launchesInEpisode: NO_RECOVERY_DELAY_MILLISECONDS,
      lifecycle: { kind: "absent" },
      lifecycleSemaphore: Semaphore.makeUnsafe(SINGLE_LIFECYCLE_PERMIT),
      options,
      resetRecoveryEpisodeAfterRetirement: false,
      scope,
    };
  }

  static make(this: void, options: PluginLifecycleOptions): PluginLifecycleHandle {
    const lifecycle = new PluginLifecycleHandle(options);
    Object.freeze(lifecycle);
    return lifecycle;
  }

  recover(plugin: RunningPlugin, reason: PluginRecoveryReason): Effect.Effect<void> {
    return recoverPluginAfterCall(this.#state, plugin, reason);
  }

  retire(): Effect.Effect<void, PluginSupervisorCleanupFailure> {
    return retirePluginHandle(this.#state);
  }

  withRunningPlugin<Success, Failure, Requirements>(
    operation: (plugin: RunningPlugin) => Effect.Effect<Success, Failure, Requirements>,
  ): Effect.Effect<Success, Failure | PluginUnavailableFailure, Requirements> {
    const demand = withPluginDemand(
      this.#state,
      ensureRunningPlugin(this.#state).pipe(Effect.flatMap(operation)),
    );
    if (this.#state.options.launch.kind === "candidate") {
      return withCandidateRetirement(this.#state, demand);
    }
    return demand;
  }
}

const makePluginLifecycle = PluginLifecycleHandle.make;

export { makePluginLifecycle };
export type { PluginLifecycleHandle, PluginLifecycleOptions, PluginRecoveryReason };
