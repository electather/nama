import { tmpdir } from "node:os";

import { Context, Effect, FiberSet, Layer, Semaphore } from "effect";

import type {
  PluginHandleState,
  PluginLogEmitter,
  PluginSupervisorLayerOptions,
  PluginSupervisorService,
} from "./model.ts";
import { makeRuntimeRoot, removePath } from "./runtime.ts";
import { closeActivePluginHandles, makePluginSupervisor } from "./service.ts";
import type { PluginSupervisorOptions } from "./service.ts";
import type { PluginStderrEventDeclaration } from "./stderr.ts";

const service = Context.Service;
const REGISTRY_SEMAPHORE_PERMITS = 1;

const makePluginSupervisorLayer = ({
  effectiveUserId = process.geteuid?.(),
  temporaryDirectory = tmpdir(),
  spawnProcess,
}: PluginSupervisorLayerOptions = {}) =>
  Layer.effect(
    PluginSupervisor,
    Effect.gen(function* makePluginSupervisorService() {
      const runtimeRoot = yield* Effect.acquireRelease(
        makeRuntimeRoot(temporaryDirectory),
        (root) => removePath(root).pipe(Effect.orDie),
      );
      const scope = yield* Effect.scope;
      const runLogEffect = yield* FiberSet.makeRuntime<never, void, never>();
      const activeHandles = new Set<PluginHandleState>();
      yield* Effect.addFinalizer(() => closeActivePluginHandles(activeHandles).pipe(Effect.orDie));
      const emit: PluginLogEmitter = (effect) => {
        runLogEffect(effect);
      };
      const options: PluginSupervisorOptions = {
        activeHandles,
        effectiveUserId,
        emit,
        instanceHandles: new Map(),
        registrySemaphore: Semaphore.makeUnsafe(REGISTRY_SEMAPHORE_PERMITS),
        runtimeRoot,
        scope,
        spawnProcess,
      };
      return PluginSupervisor.of(makePluginSupervisor(options));
    }),
  );

class PluginSupervisor extends service<PluginSupervisor, PluginSupervisorService>()(
  "@nama/server/PluginSupervisor",
) {
  static readonly layer = makePluginSupervisorLayer;
}

export { PluginSupervisor };
export type { PluginStderrEventDeclaration };
