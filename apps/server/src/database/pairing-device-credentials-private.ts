import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import { deviceSelection } from "./pairing-devices-private.ts";
import { pairingPersistenceFailure } from "./pairing-persistence-model-private.ts";
import type {
  DeviceRecord,
  PairingCredential,
  PairingPersistenceContext,
  PairingPersistenceFailure,
  PairingTransaction,
} from "./pairing-persistence-model-private.ts";
import { digestDeviceCredential } from "./pairing-protection-private.ts";
import { device, deviceCredential, pairingRequest } from "./pairing-schema.ts";

const FIRST_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

const verifyDeviceCredential = (
  context: PairingPersistenceContext,
  credential: PairingCredential,
): Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure> =>
  Effect.tryPromise({
    catch: pairingPersistenceFailure,
    try: async () => {
      const verifier = digestDeviceCredential(
        context.keys.deviceVerifier,
        credential.version,
        credential.secret,
      );
      try {
        const rows = await context.database
          .select(deviceSelection)
          .from(deviceCredential)
          .innerJoin(device, eq(device.id, deviceCredential.deviceId))
          .where(
            and(
              eq(deviceCredential.version, credential.version),
              eq(deviceCredential.verifier, verifier),
              eq(device.revoked, false),
            ),
          )
          .limit(SINGLE_ROW_LIMIT);
        return rows[FIRST_INDEX];
      } finally {
        verifier.fill(ZERO);
      }
    },
  });

const revokeStoredDevice = async (
  transaction: PairingTransaction,
  current: DeviceRecord,
): Promise<DeviceRecord> => {
  if (current.revoked) {
    return current;
  }
  const revokedRows = await transaction
    .update(device)
    .set({ revoked: true, revokedAt: sql`transaction_timestamp()` })
    .where(eq(device.id, current.id))
    .returning(deviceSelection);
  const revoked = revokedRows[FIRST_INDEX];
  if (revoked === undefined) {
    throw new Error("device revocation returned no row");
  }
  return revoked;
};

const persistDeviceRevocation = (
  context: PairingPersistenceContext,
  deviceId: string,
): Promise<DeviceRecord | undefined> =>
  context.database.transaction(async (transaction) => {
    const currentRows = await transaction
      .select(deviceSelection)
      .from(device)
      .where(eq(device.id, deviceId))
      .for("update")
      .limit(SINGLE_ROW_LIMIT);
    const current = currentRows[FIRST_INDEX];
    if (current === undefined) {
      return current;
    }
    const revoked = await revokeStoredDevice(transaction, current);
    await transaction.delete(deviceCredential).where(eq(deviceCredential.deviceId, deviceId));
    await transaction
      .update(pairingRequest)
      .set({
        deliveryAuthenticationTag: sql`null`,
        deliveryCiphertext: sql`null`,
        deliveryCredentialVersion: sql`null`,
        deliveryEnvelopeVersion: sql`null`,
        deliveryNonce: sql`null`,
      })
      .where(eq(pairingRequest.deviceId, deviceId));
    return revoked;
  });

const revokeDevice = (
  context: PairingPersistenceContext,
  deviceId: string,
): Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure> =>
  Effect.tryPromise({
    catch: pairingPersistenceFailure,
    try: () => persistDeviceRevocation(context, deviceId),
  });

const recordDeviceSeen = (
  context: PairingPersistenceContext,
  deviceId: string,
): Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure> =>
  Effect.tryPromise({
    catch: pairingPersistenceFailure,
    try: async () => {
      const lastSeenThreshold = sql`transaction_timestamp() - interval '15 minutes'`;
      const lastSeenEligible = or(
        isNull(device.lastSeenAt),
        lte(device.lastSeenAt, lastSeenThreshold),
      );
      const activeDevice = and(
        eq(device.id, deviceId),
        eq(device.revoked, false),
        lastSeenEligible,
      );
      const updated = await context.database
        .update(device)
        .set({ lastSeenAt: sql`transaction_timestamp()` })
        .where(activeDevice)
        .returning(deviceSelection);
      const updatedDevice = updated[FIRST_INDEX];
      if (updatedDevice !== undefined) {
        return updatedDevice;
      }
      const current = await context.database
        .select(deviceSelection)
        .from(device)
        .where(and(eq(device.id, deviceId), eq(device.revoked, false)))
        .limit(SINGLE_ROW_LIMIT);
      return current[FIRST_INDEX];
    },
  });

export { recordDeviceSeen, revokeDevice, verifyDeviceCredential };
