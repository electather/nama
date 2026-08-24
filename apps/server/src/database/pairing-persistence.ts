import { Effect, Fiber, Redacted, Scope } from "effect";

import type { ConfigService } from "../config/schema.ts";
import { approvePairing } from "./pairing-approval-private.ts";
import { cleanupExpiredPairings } from "./pairing-cleanup-private.ts";
import {
  recordDeviceSeen,
  revokeDevice,
  verifyDeviceCredential,
} from "./pairing-device-credentials-private.ts";
import { pairingPersistenceFailure } from "./pairing-persistence-model-private.ts";
import type {
  PairingDatabase,
  PairingPersistence,
  PairingPersistenceContext,
  PairingPersistenceFailure,
  PairingValueSource,
} from "./pairing-persistence-model-private.ts";
import {
  derivePairingProtectionKeys,
  destroyPairingProtectionKeys,
} from "./pairing-protection-private.ts";
import { beginPairing, pollPairing } from "./pairing-requests-private.ts";
import { securePairingValueSource } from "./pairing-values-private.ts";

const CLEANUP_INTERVAL_MILLISECONDS = 60_000;

interface PairingPersistenceOptions {
  readonly cleanupIntervalMilliseconds?: number;
  readonly values?: PairingValueSource;
}

interface PairingCleanupState {
  healthy: boolean;
}

interface PairingPersistenceOwner {
  readonly close: Effect.Effect<void>;
  readonly service: PairingPersistence;
}

interface AcquiredPairingPersistence {
  readonly context: PairingPersistenceContext;
  readonly state: PairingCleanupState;
}

const runCleanup = (database: PairingDatabase, state: PairingCleanupState): Effect.Effect<void> =>
  Effect.uninterruptible(
    Effect.tryPromise({
      catch: pairingPersistenceFailure,
      try: () => cleanupExpiredPairings(database),
    }).pipe(
      Effect.matchEffect({
        onFailure: () =>
          Effect.sync(() => {
            state.healthy = false;
          }),
        onSuccess: () =>
          Effect.sync(() => {
            state.healthy = true;
          }),
      }),
    ),
  );

const periodicCleanup = (
  database: PairingDatabase,
  state: PairingCleanupState,
  intervalMilliseconds: number,
) =>
  Effect.sleep(intervalMilliseconds).pipe(
    Effect.andThen(runCleanup(database, state)),
    Effect.forever,
  );

const stopPeriodicCleanup = (fiber: Fiber.Fiber<never>): Effect.Effect<void> =>
  Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)), Effect.asVoid);

const makePairingService = (
  context: PairingPersistenceContext,
  state: PairingCleanupState,
): PairingPersistence => {
  const service: PairingPersistence = {
    approvePairing: (input) => approvePairing(context, input),
    beginPairing: (input) => beginPairing(context, input.displayName),
    cleanupExpired: Effect.tryPromise({
      catch: () => {
        state.healthy = false;
        return pairingPersistenceFailure();
      },
      try: async () => {
        await cleanupExpiredPairings(context.database);
        state.healthy = true;
      },
    }),
    cleanupHealthy: () => state.healthy,
    pollPairing: (input) => pollPairing(context, input),
    recordDeviceSeen: (deviceId) => recordDeviceSeen(context, deviceId),
    revokeDevice: (deviceId) => revokeDevice(context, deviceId),
    verifyDeviceCredential: (credential) => verifyDeviceCredential(context, credential),
  };
  return Object.freeze(service);
};

const acquirePairingPersistence = async (
  database: PairingDatabase,
  masterKey: ConfigService["security"]["masterKey"],
  options: PairingPersistenceOptions,
): Promise<AcquiredPairingPersistence> => {
  const keys = await derivePairingProtectionKeys(Redacted.value(masterKey));
  try {
    await cleanupExpiredPairings(database);
  } catch (error) {
    destroyPairingProtectionKeys(keys);
    throw error;
  }
  return {
    context: {
      database,
      keys,
      values: options.values ?? securePairingValueSource,
    },
    state: { healthy: true },
  };
};

const makePairingPersistence = (
  database: PairingDatabase,
  masterKey: ConfigService["security"]["masterKey"],
  options: PairingPersistenceOptions = {},
): Effect.Effect<PairingPersistenceOwner, PairingPersistenceFailure, Scope.Scope> =>
  Effect.gen(function* makePairingPersistenceOwner() {
    const acquired = yield* Effect.tryPromise({
      catch: pairingPersistenceFailure,
      try: () => acquirePairingPersistence(database, masterKey, options),
    });
    const scope = yield* Scope.Scope;
    const cleanupLoop = periodicCleanup(
      database,
      acquired.state,
      options.cleanupIntervalMilliseconds ?? CLEANUP_INTERVAL_MILLISECONDS,
    );
    const cleanupFiber = yield* Effect.forkIn(cleanupLoop, scope);
    const destroyKeys = Effect.sync(() => {
      destroyPairingProtectionKeys(acquired.context.keys);
    });
    const close = stopPeriodicCleanup(cleanupFiber).pipe(Effect.andThen(destroyKeys));
    const service = makePairingService(acquired.context, acquired.state);
    return Object.freeze({ close, service });
  });

export {
  type PairingPersistenceOwner,
  type PairingPersistence,
  type PairingPersistenceFailure,
  type PairingPersistenceOptions,
  type PairingValueSource,
  makePairingPersistence,
};
