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
import { unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { preparePluginLaunch } from "./launch-document.ts";
import { retirePluginHandle } from "./lifecycle.ts";
import type {
  PluginHandleState,
  PreparedPluginLaunch,
  PluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  SupervisedPlugin,
} from "./model.ts";
import { validatePluginDescriptor } from "./validation.ts";

const INITIAL_LAUNCH_COUNT = 0;
const INITIAL_INSTANCE_LEASE_COUNT = 1;
const SINGLE_SEMAPHORE_PERMIT = 1;
const NO_INSTANCE_LEASES = 0;
interface InstanceHandleEntry {
  leases: number;
  readonly documentContext: string;
  readonly providerInstanceId: string;
  readonly revision: string;
  readonly state: PluginHandleState;
}

interface PluginSupervisorOptions {
  readonly activeHandles: Set<PluginHandleState>;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly instanceHandles: Map<string, InstanceHandleEntry>;
  readonly registrySemaphore: Semaphore.Semaphore;
  readonly runtimeRoot: string;
  readonly scope: Scope.Scope;
  readonly spawnProcess: PluginSpawnProcess;
}

interface PluginHandleLease {
  readonly instance: InstanceHandleEntry | undefined;
  readonly state: PluginHandleState;
}

interface SupervisedPluginConstruction {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launch: PreparedPluginLaunch;
  readonly options: PluginSupervisorOptions;
  readonly state: PluginHandleState;
}

const closeActivePluginHandles = (
  activeHandles: ReadonlySet<PluginHandleState>,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.forEach(activeHandles, (state) => retirePluginHandle(state).pipe(Effect.exit), {
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
  admission: { kind: "open" },
  idleTimer: undefined,
  launchesInEpisode: INITIAL_LAUNCH_COUNT,
  lifecycle: { kind: "absent" },
  lifecycleSemaphore: Semaphore.makeUnsafe(SINGLE_SEMAPHORE_PERMIT),
  scope,
});

const acquireIsolatedPluginHandle = (
  options: PluginSupervisorOptions,
): Effect.Effect<PluginHandleLease> =>
  Effect.sync(() => {
    const state = newPluginHandleState(options.scope);
    options.activeHandles.add(state);
    return { instance: undefined, state };
  });

const closeReplacedInstance = (
  options: PluginSupervisorOptions,
  entry: InstanceHandleEntry,
): Effect.Effect<void, PluginUnavailableFailure> =>
  retirePluginHandle(entry.state).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        options.activeHandles.delete(entry.state);
      }),
    ),
    Effect.mapError(() => unavailable("plugin_exited")),
  );

const registerInstancePluginHandle = (
  options: PluginSupervisorOptions,
  launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
): PluginHandleLease => {
  const state = newPluginHandleState(options.scope);
  const entry: InstanceHandleEntry = {
    documentContext: launch.documentContext,
    leases: INITIAL_INSTANCE_LEASE_COUNT,
    providerInstanceId: launch.providerInstanceId,
    revision: launch.revision,
    state,
  };
  options.instanceHandles.set(launch.providerInstanceId, entry);
  options.activeHandles.add(state);
  return { instance: entry, state };
};

const acquireInstancePluginHandle = (
  options: PluginSupervisorOptions,
  launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
): Effect.Effect<PluginHandleLease, PluginUnavailableFailure> =>
  options.registrySemaphore.withPermits(SINGLE_SEMAPHORE_PERMIT)(
    Effect.gen(function* acquireInstanceHandle() {
      const current = options.instanceHandles.get(launch.providerInstanceId);
      if (current !== undefined && current.revision === launch.revision) {
        if (current.documentContext !== launch.documentContext) {
          return yield* Effect.fail(unavailable("launch_document_invalid"));
        }
        current.leases += INITIAL_INSTANCE_LEASE_COUNT;
        return { instance: current, state: current.state };
      }
      if (current !== undefined) {
        yield* closeReplacedInstance(options, current);
      }
      return registerInstancePluginHandle(options, launch);
    }),
  );

const acquirePluginHandle = (
  options: PluginSupervisorOptions,
  launch: PreparedPluginLaunch,
): Effect.Effect<PluginHandleLease, PluginUnavailableFailure> => {
  if (launch.kind === "instance") {
    return acquireInstancePluginHandle(options, launch);
  }
  return acquireIsolatedPluginHandle(options);
};

const releaseIsolatedPluginHandle = (options: PluginSupervisorOptions, state: PluginHandleState) =>
  retirePluginHandle(state).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        options.activeHandles.delete(state);
      }),
    ),
  );

const releaseInstancePluginHandle = (
  options: PluginSupervisorOptions,
  entry: InstanceHandleEntry,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  options.registrySemaphore.withPermits(SINGLE_SEMAPHORE_PERMIT)(
    Effect.gen(function* releaseInstanceHandle() {
      if (entry.leases === NO_INSTANCE_LEASES) {
        yield* Effect.die("plugin instance lease underflow");
      }
      entry.leases -= INITIAL_INSTANCE_LEASE_COUNT;
      if (
        entry.leases === NO_INSTANCE_LEASES &&
        options.instanceHandles.get(entry.providerInstanceId) === entry
      ) {
        yield* retirePluginHandle(entry.state);
        options.instanceHandles.delete(entry.providerInstanceId);
        options.activeHandles.delete(entry.state);
      }
    }),
  );

const releasePluginHandle = (options: PluginSupervisorOptions, lease: PluginHandleLease) => {
  if (lease.instance === undefined) {
    return releaseIsolatedPluginHandle(options, lease.state).pipe(Effect.orDie);
  }
  return releaseInstancePluginHandle(options, lease.instance).pipe(Effect.orDie);
};

const makeSupervisedPlugin = ({
  descriptor,
  launch,
  options,
  state,
}: SupervisedPluginConstruction): SupervisedPlugin => {
  let candidateAttempted = false;
  return Object.freeze({
    call: <Input extends DescMessage, Output extends DescMessage>(
      method: DescMethodUnary<Input, Output>,
      request: MessageInitShape<Input>,
      deadlineMilliseconds: number,
    ): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
      const invoke = (): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
        const call: SupervisedCall<Input, Output> = {
          deadlineMilliseconds,
          method,
          options: { ...options, descriptor, launch },
          request,
          state,
        };
        return callSupervisedPlugin(call);
      };
      if (launch.kind !== "candidate") {
        return invoke();
      }
      return Effect.suspend(() => {
        if (candidateAttempted) {
          return Effect.fail(unavailable("plugin_exited"));
        }
        candidateAttempted = true;
        return invoke();
      });
    },
  });
};

const pluginHandleResource = (options: PluginSupervisorOptions, launch: PreparedPluginLaunch) =>
  Effect.acquireRelease(acquirePluginHandle(options, launch), (lease) =>
    releasePluginHandle(options, lease),
  );

const supervisePlugin = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: PluginLaunch,
): Effect.Effect<SupervisedPlugin, PluginUnavailableFailure, Scope.Scope> =>
  validatePluginDescriptor(descriptor, options.effectiveUserId).pipe(
    Effect.andThen(preparePluginLaunch(descriptor, launch)),
    Effect.flatMap((prepared) =>
      pluginHandleResource(options, prepared).pipe(
        Effect.map((lease) =>
          makeSupervisedPlugin({
            descriptor,
            launch: prepared,
            options,
            state: lease.state,
          }),
        ),
      ),
    ),
  );

const makePluginSupervisor = (options: PluginSupervisorOptions): PluginSupervisorService =>
  Object.freeze({
    supervise: (descriptor: PluginLaunchDescriptor, launch: PluginLaunch) =>
      supervisePlugin(options, descriptor, launch),
  });

export { closeActivePluginHandles, makePluginSupervisor };
export type { InstanceHandleEntry, PluginSupervisorOptions };
