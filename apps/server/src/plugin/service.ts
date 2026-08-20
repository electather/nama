import type {
  DescMessage,
  DescMethodUnary,
  MessageInitShape,
  MessageShape,
} from "@bufbuild/protobuf";
import { Effect } from "effect";
import type { Scope } from "effect";

import { callSupervisedPlugin } from "./call.ts";
import { unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import { PluginInstanceRegistry } from "./instance-fence.ts";
import { preparePluginLaunch } from "./launch-document.ts";
import { makePluginLifecycle } from "./lifecycle.ts";
import type { PluginLifecycleHandle } from "./lifecycle.ts";
import type {
  PluginCallFailure,
  PluginInstanceFenceMode,
  PreparedPluginLaunch,
  PluginLaunch,
  PluginLaunchDescriptor,
  PluginLogEmitter,
  PluginSpawnProcess,
  PluginSupervisorService,
  SupervisedPlugin,
} from "./model.ts";
import { validatePluginDescriptor } from "./validation.ts";

interface PluginSupervisorOptions {
  readonly effectiveUserId: number | undefined;
  readonly emit: PluginLogEmitter;
  readonly runtimeRoot: string;
  readonly scope: Scope.Scope;
  readonly spawnProcess: PluginSpawnProcess;
}

interface SupervisedPluginConstruction {
  readonly admitCall: () => Effect.Effect<void, PluginUnavailableFailure>;
  readonly launch: PreparedPluginLaunch;
  readonly lifecycle: PluginLifecycleHandle;
}

interface PluginSupervisionInput {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launch: PreparedPluginLaunch;
  readonly options: PluginSupervisorOptions;
  readonly registry: PluginInstanceRegistry;
}

interface PluginPreparationInput {
  readonly descriptor: PluginLaunchDescriptor;
  readonly launch: PluginLaunch;
  readonly options: PluginSupervisorOptions;
  readonly registry: PluginInstanceRegistry;
}

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

const makeSupervisedPlugin = ({
  admitCall,
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
      const call = admitCall().pipe(
        Effect.andThen(
          callSupervisedPlugin({
            deadlineMilliseconds,
            lifecycle,
            method,
            request,
          }),
        ),
      );
      if (launch.kind !== "candidate") {
        return call;
      }
      return Effect.suspend(() => {
        if (candidateAttempted) {
          return Effect.fail(unavailable("plugin_exited"));
        }
        candidateAttempted = true;
        return call;
      });
    },
  });
};

const pluginHandleResource = ({
  descriptor,
  launch,
  options,
  registry,
}: PluginSupervisionInput) => {
  if (launch.kind === "instance") {
    return Effect.acquireRelease(
      registry.acquireInstance(launch, () => acquirePluginLifecycle(options, descriptor, launch)),
      (lease) => lease.release.pipe(Effect.orDie),
    );
  }
  return Effect.acquireRelease(
    registry.acquireIsolated(() => acquirePluginLifecycle(options, descriptor, launch)),
    (lease) => lease.release.pipe(Effect.orDie),
  );
};

const supervisePlugin = ({ descriptor, launch, options, registry }: PluginPreparationInput) =>
  validatePluginDescriptor(descriptor, options.effectiveUserId).pipe(
    Effect.andThen(preparePluginLaunch(descriptor, launch)),
    Effect.flatMap((prepared) =>
      pluginHandleResource({ descriptor, launch: prepared, options, registry }).pipe(
        Effect.map((lease) =>
          makeSupervisedPlugin({
            admitCall: lease.admitCall,
            launch: prepared,
            lifecycle: lease.lifecycle,
          }),
        ),
      ),
    ),
  );

const makePluginSupervisor = (
  options: PluginSupervisorOptions,
): Readonly<{
  readonly close: () => Effect.Effect<void, PluginSupervisorCleanupFailure>;
  readonly service: PluginSupervisorService;
}> => {
  const registry = new PluginInstanceRegistry();
  return Object.freeze({
    close: () => registry.closeActiveHandles(),
    service: Object.freeze({
      fenceInstance: (providerInstanceId: string, mode: PluginInstanceFenceMode) =>
        registry.fenceInstance(providerInstanceId, mode),
      supervise: (descriptor: PluginLaunchDescriptor, launch: PluginLaunch) =>
        supervisePlugin({ descriptor, launch, options, registry }),
    }),
  });
};

export { makePluginSupervisor };
export type { PluginSupervisorOptions };
