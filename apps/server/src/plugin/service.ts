import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect, Exit, Fiber, Semaphore } from "effect";
import type { Scope } from "effect";

import { callSupervisedPlugin } from "./call.ts";
import type { PluginCallFailure, SupervisedCall } from "./call.ts";
import { stopPlugin } from "./cleanup.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { ABSENT_PLUGIN } from "./model.ts";
import type {
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  SupervisedPlugin,
} from "./model.ts";
import { forkPluginRecovery } from "./recovery.ts";
import { validatePluginDescriptor } from "./validation.ts";

const INITIAL_LAUNCH_COUNT = 0;
const RECOVERY_LOCK_PERMITS = 1;

interface PluginSupervisorOptions {
  readonly activeHandles: Set<PluginHandleState>;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly runtimeRoot: string;
  readonly spawnProcess: PluginSpawnProcess;
}

const closePluginHandle = (
  state: PluginHandleState,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.suspend(() => {
    if (state.closed) {
      return Effect.void;
    }
    state.closed = true;
    return Effect.gen(function* closeSupervisedPlugin() {
      if (state.recoveryFiber !== undefined) {
        yield* Fiber.interrupt(state.recoveryFiber);
      }
      if (state.current !== ABSENT_PLUGIN) {
        yield* stopPlugin(state.current);
      }
    });
  });

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
  closed: false,
  current: ABSENT_PLUGIN,
  launchesInEpisode: INITIAL_LAUNCH_COUNT,
  recoveryFiber: undefined,
  recoveryLock: Semaphore.makeUnsafe(RECOVERY_LOCK_PERMITS),
  scope,
  terminal: undefined,
  unhealthy: true,
});

const acquirePluginHandle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<PluginHandleState, never, Scope.Scope> =>
  Effect.gen(function* acquirePluginHandleEffect() {
    const scope = yield* Effect.scope;
    const state = newPluginHandleState(scope);
    options.activeHandles.add(state);
    yield* forkPluginRecovery(state, { ...options, descriptor }, INITIAL_LAUNCH_COUNT);
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

const pluginHandleResource = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
) =>
  Effect.acquireRelease(acquirePluginHandle(options, descriptor), (state) =>
    releasePluginHandle(options, state),
  );

const supervisePlugin = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
): Effect.Effect<SupervisedPlugin, PluginUnavailableFailure, Scope.Scope> =>
  validatePluginDescriptor(descriptor, options.effectiveUserId).pipe(
    Effect.andThen(pluginHandleResource(options, descriptor)),
    Effect.map((state) => makeSupervisedPlugin(state, options, descriptor)),
  );

const makePluginSupervisor = (options: PluginSupervisorOptions): PluginSupervisorService =>
  Object.freeze({
    supervise: (descriptor: PluginLaunchDescriptor) => supervisePlugin(options, descriptor),
  });

export { closeActivePluginHandles, makePluginSupervisor };
export type { PluginSupervisorOptions };
