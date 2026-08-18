import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Cause, Effect, Exit, Fiber, Semaphore } from "effect";
import type { Scope } from "effect";

import { callSupervisedPlugin } from "./call.ts";
import type { PluginCallFailure, SupervisedCall } from "./call.ts";
import { stopPlugin } from "./cleanup.ts";
import { PluginSupervisorCleanupError } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type {
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  RunningPlugin,
  SupervisedPlugin,
} from "./model.ts";
import { validatePluginDescriptor } from "./validation.ts";

const INITIAL_LAUNCH_COUNT = 0;
const LIFECYCLE_SEMAPHORE_PERMITS = 1;

type PluginHandleCloseSelection =
  | Readonly<{ readonly kind: "none" }>
  | Readonly<{ readonly kind: "plugin"; readonly plugin: RunningPlugin }>
  | Readonly<{
      readonly fiber: Fiber.Fiber<RunningPlugin, PluginUnavailableFailure>;
      readonly kind: "recovery";
      readonly prior: RunningPlugin | typeof ABSENT_PLUGIN;
    }>
  | Readonly<{
      readonly fiber: Fiber.Fiber<void, PluginSupervisorCleanupFailure>;
      readonly kind: "retirement";
    }>;

interface PluginSupervisorOptions {
  readonly activeHandles: Set<PluginHandleState>;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly runtimeRoot: string;
  readonly spawnProcess: PluginSpawnProcess;
}

const selectTerminalPluginClose = (
  plugin: RunningPlugin | typeof ABSENT_PLUGIN,
): PluginHandleCloseSelection => {
  if (plugin === ABSENT_PLUGIN) {
    return { kind: "none" };
  }
  return { kind: "plugin", plugin };
};
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

const selectPluginHandleClose = (state: PluginHandleState): PluginHandleCloseSelection => {
  const { lifecycle } = state;
  state.lifecycle = { kind: "closed" };
  if (lifecycle.kind === "absent" || lifecycle.kind === "closed") {
    return { kind: "none" };
  }
  switch (lifecycle.kind) {
    case "ready": {
      return { kind: "plugin", plugin: lifecycle.plugin };
    }
    case "recovering": {
      return {
        fiber: lifecycle.fiber,
        kind: "recovery",
        prior: lifecycle.prior,
      };
    }
    case "retiring": {
      return { fiber: lifecycle.fiber, kind: "retirement" };
    }
    case "terminal": {
      return selectTerminalPluginClose(lifecycle.plugin);
    }
    default: {
      return lifecycle satisfies never;
    }
  }
};

const closeSelectedPlugin = (
  selection: PluginHandleCloseSelection,
): Effect.Effect<void, PluginSupervisorCleanupFailure> => {
  switch (selection.kind) {
    case "none": {
      return Effect.void;
    }
    case "plugin": {
      return stopPlugin(selection.plugin);
    }
    case "recovery": {
      const interruptRecovery = interruptPluginRecovery(selection.fiber);
      const { prior } = selection;
      if (prior === ABSENT_PLUGIN) {
        return interruptRecovery;
      }
      return Effect.gen(function* closeRecoveryAndPriorPlugin() {
        const recoveryExit = yield* interruptRecovery.pipe(Effect.exit);
        const priorExit = yield* stopPlugin(prior).pipe(Effect.exit);
        if (Exit.isFailure(recoveryExit)) {
          yield* Effect.failCause(recoveryExit.cause);
        }
        if (Exit.isFailure(priorExit)) {
          yield* Effect.failCause(priorExit.cause);
        }
      });
    }
    case "retirement": {
      return Fiber.join(selection.fiber);
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
    .withPermits(LIFECYCLE_SEMAPHORE_PERMITS)(Effect.sync(() => selectPluginHandleClose(state)))
    .pipe(Effect.flatMap(closeSelectedPlugin));

const closeActivePluginHandles = (
  activeHandles: ReadonlySet<PluginHandleState>,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.forEach(activeHandles, (state) => closePluginHandle(state).pipe(Effect.exit), {
    concurrency: "unbounded",
  }).pipe(
    Effect.flatMap((exits) => {
      const failedExit = exits.find((exit) => Exit.isFailure(exit));
      if (failedExit === undefined) {
        return Effect.void;
      }
      return Effect.failCause(failedExit.cause);
    }),
  );

const newPluginHandleState = (scope: PluginHandleState["scope"]): PluginHandleState => ({
  activeDemand: 0,
  idleTimer: undefined,
  launchesInEpisode: INITIAL_LAUNCH_COUNT,
  lifecycle: { kind: "absent" },
  lifecycleSemaphore: Semaphore.makeUnsafe(LIFECYCLE_SEMAPHORE_PERMITS),
  scope,
});

const acquirePluginHandle = (
  options: PluginSupervisorOptions,
): Effect.Effect<PluginHandleState, never, Scope.Scope> =>
  Effect.gen(function* acquirePluginHandleEffect() {
    const scope = yield* Effect.scope;
    const state = newPluginHandleState(scope);
    options.activeHandles.add(state);
    return state;
  });

const releasePluginHandle = (options: PluginSupervisorOptions, state: PluginHandleState) =>
  closePluginHandle(state).pipe(
    Effect.orDie,
    Effect.ensuring(
      Effect.sync(() => {
        options.activeHandles.delete(state);
      }),
    ),
  );

const makeSupervisedPlugin = (
  state: PluginHandleState,
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
): SupervisedPlugin =>
  Object.freeze({
    call: <Input extends DescMessage, Output extends DescMessage>(
      method: DescMethodUnary<Input, Output>,
      request: MessageInitShape<Input>,
      deadlineMilliseconds: number,
    ): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
      const call: SupervisedCall<Input, Output> = {
        deadlineMilliseconds,
        method,
        options: { ...options, descriptor },
        request,
        state,
      };
      return callSupervisedPlugin(call);
    },
  });

const pluginHandleResource = (options: PluginSupervisorOptions) =>
  Effect.acquireRelease(acquirePluginHandle(options), (state) =>
    releasePluginHandle(options, state),
  );

const supervisePlugin = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<SupervisedPlugin, PluginUnavailableFailure, Scope.Scope> =>
  validatePluginDescriptor(descriptor, options.effectiveUserId).pipe(
    Effect.andThen(pluginHandleResource(options)),
    Effect.map((state) => makeSupervisedPlugin(state, options, descriptor)),
  );

const makePluginSupervisor = (options: PluginSupervisorOptions): PluginSupervisorService =>
  Object.freeze({
    supervise: (descriptor: PluginLaunchDescriptor) => supervisePlugin(options, descriptor),
  });

export { closeActivePluginHandles, makePluginSupervisor };
export type { PluginSupervisorOptions };
