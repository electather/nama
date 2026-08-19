import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect, Exit, Semaphore } from "effect";
import type { Scope } from "effect";

import { callSupervisedPlugin } from "./call.ts";
import type { PluginCallFailure, SupervisedCall } from "./call.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { closePluginHandle } from "./lifecycle.ts";
import type {
  PluginHandleState,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  SupervisedPlugin,
} from "./model.ts";
import { validatePluginDescriptor } from "./validation.ts";

const INITIAL_LAUNCH_COUNT = 0;
const LIFECYCLE_SEMAPHORE_PERMITS = 1;
interface PluginSupervisorOptions {
  readonly activeHandles: Set<PluginHandleState>;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly runtimeRoot: string;
  readonly spawnProcess: PluginSpawnProcess;
}

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
