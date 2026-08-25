import { Context, Data, Effect, Layer, Semaphore } from "effect";

const ZERO = 0;
const ACTIVITY_PERMITS = 1;
const taggedError = Data.TaggedError;
const ProviderInstanceBusy = taggedError("ProviderInstanceBusy")<Record<string, never>>;
type ProviderInstanceBusyFailure = InstanceType<typeof ProviderInstanceBusy>;

interface InstanceActivityDeletionFence {
  readonly open: Effect.Effect<void>;
}

type InstanceActivityDeletionFenceAcquire = (
  providerInstanceId: string,
) => Effect.Effect<InstanceActivityDeletionFence, ProviderInstanceBusyFailure>;

interface ProviderActivitySlot {
  active: number;
  deletionFenced: boolean;
  readonly semaphore: Semaphore.Semaphore;
}

interface ProviderActivityAdmission {
  readonly fenceForDeletion: InstanceActivityDeletionFenceAcquire;
  readonly run: <Success, Failure, Requirements>(
    providerInstanceId: string,
    activity: Effect.Effect<Success, Failure, Requirements>,
  ) => Effect.Effect<Success, Failure | ProviderInstanceBusyFailure, Requirements>;
}

const slotFor = (
  slots: Map<string, ProviderActivitySlot>,
  providerInstanceId: string,
): ProviderActivitySlot => {
  const current = slots.get(providerInstanceId);
  if (current !== undefined) {
    return current;
  }
  const created = {
    active: ZERO,
    deletionFenced: false,
    semaphore: Semaphore.makeUnsafe(ACTIVITY_PERMITS),
  };
  slots.set(providerInstanceId, created);
  return created;
};

const runProviderActivity = <Success, Failure, Requirements>(
  slots: Map<string, ProviderActivitySlot>,
  providerInstanceId: string,
  activity: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Success, Failure | ProviderInstanceBusyFailure, Requirements> => {
  const slot = slotFor(slots, providerInstanceId);
  const acquire = slot.semaphore.withPermits(ACTIVITY_PERMITS)(
    Effect.suspend(() => {
      if (slot.deletionFenced) {
        return Effect.fail(new ProviderInstanceBusy({}));
      }
      return Effect.sync(() => {
        slot.active += ACTIVITY_PERMITS;
      });
    }),
  );
  const release = slot.semaphore.withPermits(ACTIVITY_PERMITS)(
    Effect.sync(() => {
      slot.active -= ACTIVITY_PERMITS;
    }),
  );
  return Effect.acquireUseRelease(
    acquire,
    () => activity,
    () => release,
  );
};

const fenceProviderActivity = (
  slots: Map<string, ProviderActivitySlot>,
  providerInstanceId: string,
): Effect.Effect<InstanceActivityDeletionFence, ProviderInstanceBusyFailure> => {
  const slot = slotFor(slots, providerInstanceId);
  return slot.semaphore.withPermits(ACTIVITY_PERMITS)(
    Effect.suspend(() => {
      if (slot.deletionFenced || slot.active > ZERO) {
        return Effect.fail(new ProviderInstanceBusy({}));
      }
      slot.deletionFenced = true;
      let fenceClosed = true;
      return Effect.succeed({
        open: slot.semaphore.withPermits(ACTIVITY_PERMITS)(
          Effect.sync(() => {
            if (fenceClosed) {
              fenceClosed = false;
              slot.deletionFenced = false;
            }
          }),
        ),
      });
    }),
  );
};

const makeProviderActivityAdmission = (): ProviderActivityAdmission => {
  const slots = new Map<string, ProviderActivitySlot>();
  const fenceForDeletion: ProviderActivityAdmission["fenceForDeletion"] = (providerInstanceId) =>
    fenceProviderActivity(slots, providerInstanceId);
  const run: ProviderActivityAdmission["run"] = (providerInstanceId, activity) =>
    runProviderActivity(slots, providerInstanceId, activity);
  return Object.freeze({ fenceForDeletion, run });
};

const contextService = Context.Service;

class ProviderActivity extends contextService<ProviderActivity, ProviderActivityAdmission>()(
  "@nama/server/ProviderActivity",
) {
  static readonly layer = Layer.sync(ProviderActivity, () =>
    ProviderActivity.of(makeProviderActivityAdmission()),
  );
}

export { ProviderActivity, ProviderInstanceBusy, makeProviderActivityAdmission };
export type {
  InstanceActivityDeletionFence,
  InstanceActivityDeletionFenceAcquire,
  ProviderActivityAdmission,
  ProviderInstanceBusyFailure,
};
