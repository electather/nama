import { and, eq, gt, sql } from "drizzle-orm";

import type { JsonObject } from "./database-types-private.ts";
import { lockPairingState } from "./pairing-cleanup-private.ts";
import { parseStoredDevice, serializeDevice } from "./pairing-devices-private.ts";
import {
  PairingOperationKeyReused,
  pairingPersistenceFailure,
} from "./pairing-persistence-model-private.ts";
import type {
  ApprovePairingInput,
  DeviceRecord,
  PairingApproval,
  PairingTransaction,
} from "./pairing-persistence-model-private.ts";
import { protectedValuesMatch } from "./pairing-protection-private.ts";
import { pairingApprovalResult } from "./pairing-schema.ts";

const APPROVE_PAIRING_METHOD = "nama.api.v1.DeviceService.ApprovePairing";
const FIRST_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;

interface StoredApprovalResult {
  readonly requestFingerprint: Buffer;
  readonly response: JsonObject;
}

interface ApprovalResultInput {
  readonly device: DeviceRecord;
  readonly deviceId: string;
  readonly input: ApprovePairingInput;
  readonly pairingId: string;
  readonly requestFingerprint: Buffer;
}

const replayApproval = (fingerprint: Buffer, stored: StoredApprovalResult): PairingApproval => {
  if (!protectedValuesMatch(fingerprint, stored.requestFingerprint)) {
    throw new PairingOperationKeyReused({});
  }
  const storedDevice = parseStoredDevice(stored.response);
  if (storedDevice === undefined) {
    throw pairingPersistenceFailure();
  }
  return { device: storedDevice, replayed: true };
};

const lockOperationAndReadReplay = async (
  transaction: PairingTransaction,
  input: ApprovePairingInput,
  requestFingerprint: Buffer,
): Promise<PairingApproval | false> => {
  await lockPairingState(transaction);
  const operationRows = await transaction
    .select({
      requestFingerprint: pairingApprovalResult.requestFingerprint,
      response: pairingApprovalResult.response,
    })
    .from(pairingApprovalResult)
    .where(
      and(
        eq(pairingApprovalResult.administratorUserId, input.administratorUserId),
        eq(pairingApprovalResult.method, APPROVE_PAIRING_METHOD),
        eq(pairingApprovalResult.operationId, input.operationId),
        gt(pairingApprovalResult.expiresAt, sql`transaction_timestamp()`),
      ),
    )
    .limit(SINGLE_ROW_LIMIT);
  const storedOperation = operationRows[FIRST_INDEX];
  if (storedOperation === undefined) {
    return false;
  }
  return replayApproval(requestFingerprint, storedOperation);
};

const storeApprovalResult = async (
  transaction: PairingTransaction,
  result: ApprovalResultInput,
): Promise<void> => {
  await transaction.insert(pairingApprovalResult).values({
    administratorUserId: result.input.administratorUserId,
    deviceId: result.deviceId,
    expiresAt: sql`transaction_timestamp() + interval '24 hours'`,
    method: APPROVE_PAIRING_METHOD,
    operationId: result.input.operationId,
    pairingId: result.pairingId,
    requestFingerprint: result.requestFingerprint,
    response: serializeDevice(result.device),
  });
};

export {
  type ApprovalResultInput,
  APPROVE_PAIRING_METHOD,
  lockOperationAndReadReplay,
  storeApprovalResult,
};
