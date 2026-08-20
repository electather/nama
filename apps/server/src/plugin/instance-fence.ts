import { Effect, Exit, Semaphore } from "effect";
import type { Scope } from "effect";

import { unavailable } from "./errors.ts";
import type { PluginSupervisorCleanupFailure, PluginUnavailableFailure } from "./errors.ts";
import type { PluginLifecycleHandle } from "./lifecycle.ts";
import type {
  PluginInstanceFence,
  PluginInstanceFenceMode,
  PreparedPluginLaunch,
} from "./model.ts";

const INITIAL_INSTANCE_LEASE_COUNT = 1;
const NO_INSTANCE_LEASES = 0;
const SINGLE_SEMAPHORE_PERMIT = 1;
const EMPTY_LENGTH = 0;

type InstancePluginLaunch = Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>;

interface InstanceHandleEntry {
  readonly documentContext: string;
  leases: number;
  readonly lifecycle: PluginLifecycleHandle;
  readonly revision: string;
}

interface InstanceFenceSlot {
  admission: string | undefined;
  fenced: boolean;
  entry: InstanceHandleEntry | undefined;
  readonly semaphore: Semaphore.Semaphore;
}

interface PluginHandleLease {
  readonly admitCall: () => Effect.Effect<void, PluginUnavailableFailure>;
  readonly lifecycle: PluginLifecycleHandle;
  readonly release: Effect.Effect<void, PluginSupervisorCleanupFailure>;
}

interface InstanceFenceLease {
  readonly fence: PluginInstanceFence;
  readonly release: Effect.Effect<void>;
}

class PluginInstanceRegistry {
  readonly #activeHandles = new Set<PluginLifecycleHandle>();
  readonly #slots = new Map<string, InstanceFenceSlot>();

  #slot(providerInstanceId: string): InstanceFenceSlot {
    const existing = this.#slots.get(providerInstanceId);
    if (existing !== undefined) {
      return existing;
    }
    const created: InstanceFenceSlot = {
      admission: undefined,
      entry: undefined,
      fenced: false,
      semaphore: Semaphore.makeUnsafe(SINGLE_SEMAPHORE_PERMIT),
    };
    this.#slots.set(providerInstanceId, created);
    return created;
  }

  #requireAdmittedRevision(
    slot: InstanceFenceSlot,
    revision: string,
  ): Effect.Effect<void, PluginUnavailableFailure> {
    if (slot.fenced && slot.admission !== revision) {
      return Effect.fail(unavailable("plugin_exited"));
    }
    return Effect.void;
  }

  #retireCurrent(slot: InstanceFenceSlot): Effect.Effect<void, PluginUnavailableFailure> {
    const current = slot.entry;
    if (current === undefined) {
      return Effect.void;
    }
    return current.lifecycle.retire().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.#activeHandles.delete(current.lifecycle);
          if (slot.entry === current) {
            slot.entry = undefined;
          }
        }),
      ),
      Effect.mapError(() => unavailable("plugin_exited")),
    );
  }

  #registerInstance(
    slot: InstanceFenceSlot,
    launch: InstancePluginLaunch,
    createLifecycle: () => PluginLifecycleHandle,
  ): PluginHandleLease {
    const lifecycle = createLifecycle();
    const entry: InstanceHandleEntry = {
      documentContext: launch.documentContext,
      leases: INITIAL_INSTANCE_LEASE_COUNT,
      lifecycle,
      revision: launch.revision,
    };
    slot.entry = entry;
    this.#activeHandles.add(lifecycle);
    return {
      admitCall: () => Effect.suspend(() => this.#requireAdmittedRevision(slot, launch.revision)),
      lifecycle,
      release: this.#releaseInstance(slot, entry),
    };
  }

  #leaseAdmittedInstance(
    slot: InstanceFenceSlot,
    launch: InstancePluginLaunch,
    createLifecycle: () => PluginLifecycleHandle,
  ): Effect.Effect<PluginHandleLease, PluginUnavailableFailure> {
    const current = slot.entry;
    if (current === undefined) {
      return Effect.sync(() => this.#registerInstance(slot, launch, createLifecycle));
    }
    if (current.revision === launch.revision) {
      if (current.documentContext !== launch.documentContext) {
        return Effect.fail(unavailable("launch_document_invalid"));
      }
      return Effect.sync(() => {
        current.leases += INITIAL_INSTANCE_LEASE_COUNT;
        return {
          admitCall: () =>
            Effect.suspend(() => this.#requireAdmittedRevision(slot, launch.revision)),
          lifecycle: current.lifecycle,
          release: this.#releaseInstance(slot, current),
        };
      });
    }
    return this.#retireCurrent(slot).pipe(
      Effect.andThen(Effect.sync(() => this.#registerInstance(slot, launch, createLifecycle))),
    );
  }

  acquireIsolated(createLifecycle: () => PluginLifecycleHandle): Effect.Effect<
    Readonly<{
      readonly admitCall: () => Effect.Effect<void, PluginUnavailableFailure>;
      readonly lifecycle: PluginLifecycleHandle;
      readonly release: Effect.Effect<void, PluginSupervisorCleanupFailure>;
    }>
  > {
    return Effect.sync(() => {
      const lifecycle = createLifecycle();
      this.#activeHandles.add(lifecycle);
      return {
        admitCall: () => Effect.void,
        lifecycle,
        release: lifecycle.retire().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              this.#activeHandles.delete(lifecycle);
            }),
          ),
        ),
      };
    });
  }

  acquireInstance(
    launch: Extract<PreparedPluginLaunch, Readonly<{ readonly kind: "instance" }>>,
    createLifecycle: () => PluginLifecycleHandle,
  ): Effect.Effect<
    Readonly<{
      readonly admitCall: () => Effect.Effect<void, PluginUnavailableFailure>;
      readonly lifecycle: PluginLifecycleHandle;
      readonly release: Effect.Effect<void, PluginSupervisorCleanupFailure>;
    }>,
    PluginUnavailableFailure
  > {
    return Effect.suspend(() => {
      const slot = this.#slot(launch.providerInstanceId);
      return slot.semaphore.withPermits(SINGLE_SEMAPHORE_PERMIT)(
        Effect.suspend(() =>
          this.#requireAdmittedRevision(slot, launch.revision).pipe(
            Effect.andThen(
              Effect.suspend(() => this.#leaseAdmittedInstance(slot, launch, createLifecycle)),
            ),
          ),
        ),
      );
    });
  }

  #releaseInstance(
    slot: InstanceFenceSlot,
    entry: InstanceHandleEntry,
  ): Effect.Effect<void, PluginSupervisorCleanupFailure> {
    return slot.semaphore.withPermits(SINGLE_SEMAPHORE_PERMIT)(
      Effect.suspend(() => {
        if (entry.leases === NO_INSTANCE_LEASES) {
          return Effect.die("plugin instance lease underflow");
        }
        entry.leases -= INITIAL_INSTANCE_LEASE_COUNT;
        if (entry.leases !== NO_INSTANCE_LEASES || slot.entry !== entry) {
          return Effect.void;
        }
        return entry.lifecycle.retire().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              slot.entry = undefined;
              this.#activeHandles.delete(entry.lifecycle);
            }),
          ),
        );
      }),
    );
  }

  #acquireFence(
    providerInstanceId: string,
    mode: PluginInstanceFenceMode,
  ): Effect.Effect<InstanceFenceLease, PluginUnavailableFailure> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const slot = this.#slot(providerInstanceId);
        const retireCurrent = Effect.suspend(() => {
          if (mode !== "retire-current") {
            return Effect.void;
          }
          return this.#retireCurrent(slot);
        });
        return restore(slot.semaphore.take(SINGLE_SEMAPHORE_PERMIT)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              slot.fenced = true;
              slot.admission = undefined;
            }),
          ),
          Effect.andThen(retireCurrent),
          Effect.map(() => this.#fenceLease(slot)),
          Effect.tapError(() =>
            slot.semaphore.release(SINGLE_SEMAPHORE_PERMIT).pipe(Effect.asVoid),
          ),
        );
      }),
    );
  }

  #fenceLease(slot: InstanceFenceSlot): InstanceFenceLease {
    let active = true;
    return {
      fence: Object.freeze({
        open: (revision: string) =>
          Effect.sync(() => {
            if (!active || revision.length === EMPTY_LENGTH) {
              throw new Error("plugin instance fence is closed");
            }
            slot.admission = revision;
          }),
      }),
      release: Effect.sync(() => {
        active = false;
      }).pipe(Effect.andThen(slot.semaphore.release(SINGLE_SEMAPHORE_PERMIT).pipe(Effect.asVoid))),
    };
  }

  fenceInstance(
    providerInstanceId: string,
    mode: PluginInstanceFenceMode,
  ): Effect.Effect<PluginInstanceFence, PluginUnavailableFailure, Scope.Scope> {
    return Effect.acquireRelease(
      this.#acquireFence(providerInstanceId, mode),
      (lease) => lease.release,
    ).pipe(Effect.map((lease) => lease.fence));
  }

  closeActiveHandles(): Effect.Effect<void, PluginSupervisorCleanupFailure> {
    return Effect.forEach(
      this.#activeHandles,
      (lifecycle) => lifecycle.retire().pipe(Effect.exit),
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.flatMap((exits) => {
        const failedExit = exits.find((exit) => Exit.isFailure(exit));
        if (failedExit === undefined) {
          return Effect.void;
        }
        return Effect.failCause(failedExit.cause);
      }),
    );
  }
}

export { PluginInstanceRegistry };
