import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect, Exit } from "effect";
import type { Scope, Semaphore } from "effect";

import { callSupervisedPlugin } from "./call.ts";
import { unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { closeInstanceEntry, fenceInstancePlugin } from "./instance-fence.ts";
import { preparePluginLaunch } from "./launch-document.ts";
import { makePluginLifecycle } from "./lifecycle.ts";
import type { PluginLifecycleHandle } from "./lifecycle.ts";
import type {
  PluginCallFailure,
  PreparedPluginLaunch,
  PluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  SupervisedPlugin,
} from "./model.ts";
import { validatePluginDescriptor } from "./validation.ts";

const INITIAL_INSTANCE_LEASE_COUNT = 1;
const SINGLE_SEMAPHORE_PERMIT = 1;
const NO_INSTANCE_LEASES = 0;
interface InstanceHandleEntry {
  leases: number;
  readonly documentContext: string;
  readonly lifecycle: PluginLifecycleHandle;
  readonly providerInstanceId: string;
  readonly revision: string;
}

interface PluginSupervisorOptions {
  readonly activeHandles: Set<PluginLifecycleHandle>;
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly instanceAdmissions: Map<string, string | undefined>;
  readonly instanceHandles: Map<string, InstanceHandleEntry>;
  readonly registrySemaphore: Semaphore.Semaphore;
  readonly runtimeRoot: string;
  readonly scope: Scope.Scope;
  readonly spawnProcess: PluginSpawnProcess;
}

interface PluginHandleLease {
  readonly instance: InstanceHandleEntry | undefined;
  readonly lifecycle: PluginLifecycleHandle;
}

interface SupervisedPluginConstruction {
  readonly launch: PreparedPluginLaunch;
  readonly lifecycle: PluginLifecycleHandle;
}

const closeActivePluginHandles = (
  activeHandles: ReadonlySet<PluginLifecycleHandle>,
): Effect.Effect<void, PluginSupervisorCleanupFailure> =>
  Effect.forEach(activeHandles, (lifecycle) => lifecycle.retire().pipe(Effect.exit), {
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

const acquirePluginLifecycle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: PreparedPluginLaunch,
): PluginLifecycleHandle => {
  const { effectiveUserId, emit, runtimeRoot, scope, spawnProcess } = options;
  return makePluginLifecycle({
    descriptor,
    effectiveUserId,
    emit,
    launch,
    runtimeRoot,
    scope,
    spawnProcess,
  });
};

const acquireIsolatedPluginHandle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: PreparedPluginLaunch,
): Effect.Effect<PluginHandleLease> =>
  Effect.sync(() => {
    const lifecycle = acquirePluginLifecycle(options, descriptor, launch);
    options.activeHandles.add(lifecycle);
    return { instance: undefined, lifecycle };
  });

const registerInstancePluginHandle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
): PluginHandleLease => {
  const lifecycle = acquirePluginLifecycle(options, descriptor, launch);
  const entry: InstanceHandleEntry = {
    documentContext: launch.documentContext,
    leases: INITIAL_INSTANCE_LEASE_COUNT,
    lifecycle,
    providerInstanceId: launch.providerInstanceId,
    revision: launch.revision,
  };
  options.instanceHandles.set(launch.providerInstanceId, entry);
  options.activeHandles.add(lifecycle);
  return { instance: entry, lifecycle };
};

const requireAdmittedInstanceRevision = (
  options: PluginSupervisorOptions,
  launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
): Effect.Effect<void, PluginUnavailableFailure> => {
  const admittedRevision = options.instanceAdmissions.get(launch.providerInstanceId);
  if (
    options.instanceAdmissions.has(launch.providerInstanceId) &&
    admittedRevision !== launch.revision
  ) {
    return Effect.fail(unavailable("plugin_exited"));
  }
  return Effect.void;
};

const acquireInstancePluginHandle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
): Effect.Effect<PluginHandleLease, PluginUnavailableFailure> =>
  options.registrySemaphore.withPermits(SINGLE_SEMAPHORE_PERMIT)(
    Effect.gen(function* acquireInstanceHandle() {
      yield* requireAdmittedInstanceRevision(options, launch);
      const current = options.instanceHandles.get(launch.providerInstanceId);
      if (current !== undefined && current.revision === launch.revision) {
        if (current.documentContext !== launch.documentContext) {
          return yield* Effect.fail(unavailable("launch_document_invalid"));
        }
        current.leases += INITIAL_INSTANCE_LEASE_COUNT;
        return { instance: current, lifecycle: current.lifecycle };
      }
      if (current !== undefined) {
        yield* closeInstanceEntry(options.activeHandles, current);
      }
      return registerInstancePluginHandle(options, descriptor, launch);
    }),
  );

const acquirePluginHandle = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: PreparedPluginLaunch,
): Effect.Effect<PluginHandleLease, PluginUnavailableFailure> => {
  if (launch.kind === "instance") {
    return acquireInstancePluginHandle(options, descriptor, launch);
  }
  return acquireIsolatedPluginHandle(options, descriptor, launch);
};

const releaseIsolatedPluginHandle = (
  options: PluginSupervisorOptions,
  lifecycle: PluginLifecycleHandle,
) =>
  lifecycle.retire().pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        options.activeHandles.delete(lifecycle);
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
        yield* entry.lifecycle.retire();
        options.instanceHandles.delete(entry.providerInstanceId);
        options.activeHandles.delete(entry.lifecycle);
      }
    }),
  );

const releasePluginHandle = (options: PluginSupervisorOptions, lease: PluginHandleLease) => {
  if (lease.instance === undefined) {
    return releaseIsolatedPluginHandle(options, lease.lifecycle).pipe(Effect.orDie);
  }
  return releaseInstancePluginHandle(options, lease.instance).pipe(Effect.orDie);
};

const makeSupervisedPlugin = ({
  launch,
  lifecycle,
}: SupervisedPluginConstruction): SupervisedPlugin => {
  let candidateAttempted = false;
  return Object.freeze({
    call: <Input extends DescMessage, Output extends DescMessage>(
      method: DescMethodUnary<Input, Output>,
      request: MessageInitShape<Input>,
      deadlineMilliseconds: number,
    ): Effect.Effect<MessageShape<Output>, PluginCallFailure> => {
      const invoke = (): Effect.Effect<MessageShape<Output>, PluginCallFailure> =>
        callSupervisedPlugin({
          deadlineMilliseconds,
          lifecycle,
          method,
          request,
        });
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

const pluginHandleResource = (
  options: PluginSupervisorOptions,
  descriptor: PluginLaunchDescriptor,
  launch: PreparedPluginLaunch,
) =>
  Effect.acquireRelease(acquirePluginHandle(options, descriptor, launch), (lease) =>
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
      pluginHandleResource(options, descriptor, prepared).pipe(
        Effect.map((lease) =>
          makeSupervisedPlugin({
            launch: prepared,
            lifecycle: lease.lifecycle,
          }),
        ),
      ),
    ),
  );

const makePluginSupervisor = (options: PluginSupervisorOptions): PluginSupervisorService =>
  Object.freeze({
    fenceInstance: (providerInstanceId: string, retireCurrent: boolean) =>
      fenceInstancePlugin(options, providerInstanceId, retireCurrent),
    supervise: (descriptor: PluginLaunchDescriptor, launch: PluginLaunch) =>
      supervisePlugin(options, descriptor, launch),
  });

export { closeActivePluginHandles, makePluginSupervisor };
export type { InstanceHandleEntry, PluginSupervisorOptions };
