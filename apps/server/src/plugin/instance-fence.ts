import { Effect } from "effect";
import type { Scope, Semaphore } from "effect";

import { unavailable } from "./errors.ts";
import type { PluginUnavailableFailure } from "./errors.ts";
import type { PluginLifecycleHandle } from "./lifecycle.ts";
import type { PluginInstanceFence } from "./model.ts";

const SINGLE_SEMAPHORE_PERMIT = 1;
const EMPTY_LENGTH = 0;

interface InstanceFenceEntry {
  readonly lifecycle: PluginLifecycleHandle;
  readonly providerInstanceId: string;
}

interface InstanceFenceOptions {
  readonly activeHandles: Set<PluginLifecycleHandle>;
  readonly instanceAdmissions: Map<string, string | undefined>;
  readonly instanceHandles: Map<string, InstanceFenceEntry>;
  readonly registrySemaphore: Semaphore.Semaphore;
}

interface AcquiredInstanceFence {
  readonly close: () => void;
  readonly fence: PluginInstanceFence;
}

const closeInstanceEntry = (
  activeHandles: Set<PluginLifecycleHandle>,
  entry: InstanceFenceEntry,
): Effect.Effect<void, PluginUnavailableFailure> =>
  entry.lifecycle.retire().pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        activeHandles.delete(entry.lifecycle);
      }),
    ),
    Effect.mapError(() => unavailable("plugin_exited")),
  );

const retireCurrentInstance = (
  options: InstanceFenceOptions,
  providerInstanceId: string,
): Effect.Effect<void, PluginUnavailableFailure> =>
  Effect.gen(function* retireInstance() {
    const current = options.instanceHandles.get(providerInstanceId);
    if (current === undefined) {
      return;
    }
    yield* closeInstanceEntry(options.activeHandles, current);
    options.instanceHandles.delete(providerInstanceId);
  });

const acquiredInstanceFence = (
  options: InstanceFenceOptions,
  providerInstanceId: string,
): AcquiredInstanceFence => {
  let active = true;
  return {
    close: () => {
      active = false;
    },
    fence: Object.freeze({
      open: (revision: string) =>
        Effect.sync(() => {
          if (!active || revision.length === EMPTY_LENGTH) {
            throw new Error("plugin instance fence is closed");
          }
          options.instanceAdmissions.set(providerInstanceId, revision);
        }),
    }),
  };
};

const acquireInstanceFence = (
  options: InstanceFenceOptions,
  providerInstanceId: string,
  retireCurrent: boolean,
): Effect.Effect<AcquiredInstanceFence, PluginUnavailableFailure> =>
  Effect.uninterruptibleMask((restore) =>
    restore(options.registrySemaphore.take(SINGLE_SEMAPHORE_PERMIT)).pipe(
      Effect.flatMap(() => {
        let retirement: Effect.Effect<void, PluginUnavailableFailure> = Effect.void;
        if (retireCurrent) {
          retirement = retireCurrentInstance(options, providerInstanceId);
        }
        return retirement.pipe(
          Effect.andThen(
            Effect.sync(() => {
              options.instanceAdmissions.set(providerInstanceId, undefined);
              return acquiredInstanceFence(options, providerInstanceId);
            }),
          ),
          Effect.tapError(() =>
            options.registrySemaphore.release(SINGLE_SEMAPHORE_PERMIT).pipe(Effect.asVoid),
          ),
        );
      }),
    ),
  );

const fenceInstancePlugin = (
  options: InstanceFenceOptions,
  providerInstanceId: string,
  retireCurrent: boolean,
): Effect.Effect<PluginInstanceFence, PluginUnavailableFailure, Scope.Scope> =>
  Effect.acquireRelease(
    acquireInstanceFence(options, providerInstanceId, retireCurrent),
    (acquired) =>
      Effect.sync(acquired.close).pipe(
        Effect.andThen(
          options.registrySemaphore.release(SINGLE_SEMAPHORE_PERMIT).pipe(Effect.asVoid),
        ),
      ),
  ).pipe(Effect.map((acquired) => acquired.fence));

export type { InstanceFenceEntry, InstanceFenceOptions };
export { closeInstanceEntry, fenceInstancePlugin };
