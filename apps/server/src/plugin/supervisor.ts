import { tmpdir } from "node:os";

import { Context, Effect, FiberSet, Layer } from "effect";

import type {
  PluginLogEmitter,
  PluginSupervisorLayerOptions,
  PluginSupervisorService,
} from "./model.ts";
import { makeRuntimeRoot, removePath } from "./runtime.ts";
import { makePluginSupervisor } from "./service.ts";
import type { PluginSupervisorOptions } from "./service.ts";
import type { PluginStderrEventDeclaration } from "./stderr.ts";

const service = Context.Service;

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
      const emit: PluginLogEmitter = (effect) => {
        runLogEffect(effect);
      };
      const options: PluginSupervisorOptions = {
        effectiveUserId,
        emit,
        runtimeRoot,
        scope,
        spawnProcess,
      };
      const supervisor = makePluginSupervisor(options);
      yield* Effect.addFinalizer(() => supervisor.close().pipe(Effect.orDie));
      return PluginSupervisor.of(supervisor.service);
    }),
  );

class PluginSupervisor extends service<PluginSupervisor, PluginSupervisorService>()(
  "@nama/server/PluginSupervisor",
) {
  static readonly layer = makePluginSupervisorLayer;
}

export { PluginSupervisor };
export type { PluginStderrEventDeclaration };
