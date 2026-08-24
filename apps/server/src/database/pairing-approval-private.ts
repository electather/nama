import { and, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  APPROVE_PAIRING_METHOD,
  lockOperationAndReadReplay,
  storeApprovalResult,
} from "./pairing-approval-results-private.ts";
import { deviceSelection } from "./pairing-devices-private.ts";
import {
  PairingAlreadyApproved,
  PairingCodeInvalid,
  PairingExpired,
  PairingOperationKeyReused,
  normalizePairingFailure,
} from "./pairing-persistence-model-private.ts";
import type {
  ApprovePairingInput,
  DeviceRecord,
  PairingApproval,
  PairingCredential,
  PairingFailure,
  PairingPersistenceContext,
  PairingTransaction,
} from "./pairing-persistence-model-private.ts";
import {
  digestDeviceCredential,
  digestHumanCode,
  encryptPairingDelivery,
  fingerprintApproval,
} from "./pairing-protection-private.ts";
import type { DeliveryEnvelope } from "./pairing-protection-private.ts";
import { device, deviceCredential, pairingRequest } from "./pairing-schema.ts";
import {
  CREDENTIAL_VERSION,
  isValidOperationId,
  normalizeHumanCode,
} from "./pairing-values-private.ts";

const EXPECTED_UPDATED_PAIRINGS = 1;
const FIRST_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

interface ApprovalMaterial {
  readonly humanCodeDigest: Buffer;
  readonly requestFingerprint: Buffer;
}

interface PendingPairing {
  readonly displayName: string;
  readonly id: string;
}

interface ProtectedDeviceMaterial {
  readonly credential: PairingCredential;
  readonly deviceId: string;
  readonly envelope: DeliveryEnvelope;
  readonly verifier: Buffer;
}

interface ApprovalCommit {
  readonly input: ApprovePairingInput;
  readonly material: ApprovalMaterial;
  readonly pairing: PendingPairing;
  readonly protectedDevice: ProtectedDeviceMaterial;
}

const lockPendingPairing = async (
  transaction: PairingTransaction,
  humanCodeDigest: Buffer,
): Promise<PendingPairing> => {
  const pairingRows = await transaction
    .select({
      deviceId: pairingRequest.deviceId,
      displayName: pairingRequest.displayName,
      expired: sql<boolean>`${pairingRequest.expiresAt} <= transaction_timestamp()`,
      id: pairingRequest.id,
      status: pairingRequest.status,
    })
    .from(pairingRequest)
    .where(
      and(
        eq(pairingRequest.humanCodeVersion, CREDENTIAL_VERSION),
        eq(pairingRequest.humanCodeDigest, humanCodeDigest),
      ),
    )
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  const pairing = pairingRows[FIRST_INDEX];
  if (pairing === undefined) {
    throw new PairingCodeInvalid({});
  }
  if (pairing.expired) {
    throw new PairingExpired({});
  }
  if (pairing.status !== "pending" || pairing.deviceId !== null) {
    throw new PairingAlreadyApproved({});
  }
  return { displayName: pairing.displayName, id: pairing.id };
};

const protectDevice = (
  context: PairingPersistenceContext,
  pairing: PendingPairing,
): ProtectedDeviceMaterial => {
  const deviceId = context.values.deviceId();
  const credential = {
    secret: context.values.secret(),
    version: CREDENTIAL_VERSION,
  };
  return {
    credential,
    deviceId,
    envelope: encryptPairingDelivery(
      context.keys.deliveryEnvelope,
      {
        credentialVersion: credential.version,
        deviceId,
        pairingId: pairing.id,
      },
      credential.secret,
    ),
    verifier: digestDeviceCredential(
      context.keys.deviceVerifier,
      credential.version,
      credential.secret,
    ),
  };
};

const destroyProtectedDevice = (material: ProtectedDeviceMaterial): void => {
  material.verifier.fill(ZERO);
  material.envelope.authenticationTag.fill(ZERO);
  material.envelope.ciphertext.fill(ZERO);
  material.envelope.nonce.fill(ZERO);
};

const insertDeviceRecords = async (
  transaction: PairingTransaction,
  commit: ApprovalCommit,
): Promise<DeviceRecord> => {
  const deviceRows = await transaction
    .insert(device)
    .values({ displayName: commit.pairing.displayName, id: commit.protectedDevice.deviceId })
    .returning(deviceSelection);
  const storedDevice = deviceRows[FIRST_INDEX];
  if (storedDevice === undefined) {
    throw new Error("device insert returned no row");
  }
  await transaction.insert(deviceCredential).values({
    deviceId: commit.protectedDevice.deviceId,
    verifier: commit.protectedDevice.verifier,
    version: commit.protectedDevice.credential.version,
  });
  return storedDevice;
};

const markPairingApproved = async (
  transaction: PairingTransaction,
  commit: ApprovalCommit,
): Promise<void> => {
  const { protectedDevice } = commit;
  const approvedRows = await transaction
    .update(pairingRequest)
    .set({
      approvedAt: sql`transaction_timestamp()`,
      deliveryAuthenticationTag: protectedDevice.envelope.authenticationTag,
      deliveryCiphertext: protectedDevice.envelope.ciphertext,
      deliveryCredentialVersion: protectedDevice.credential.version,
      deliveryEnvelopeVersion: protectedDevice.envelope.envelopeVersion,
      deliveryNonce: protectedDevice.envelope.nonce,
      deviceId: protectedDevice.deviceId,
      status: "approved",
    })
    .where(
      and(
        eq(pairingRequest.id, commit.pairing.id),
        eq(pairingRequest.status, "pending"),
        gt(pairingRequest.expiresAt, sql`transaction_timestamp()`),
      ),
    )
    .returning({ id: pairingRequest.id });
  if (approvedRows.length !== EXPECTED_UPDATED_PAIRINGS) {
    throw new PairingExpired({});
  }
};

const commitApproval = async (
  transaction: PairingTransaction,
  commit: ApprovalCommit,
): Promise<PairingApproval> => {
  try {
    const storedDevice = await insertDeviceRecords(transaction, commit);
    await markPairingApproved(transaction, commit);
    await storeApprovalResult(transaction, {
      device: storedDevice,
      deviceId: commit.protectedDevice.deviceId,
      input: commit.input,
      pairingId: commit.pairing.id,
      requestFingerprint: commit.material.requestFingerprint,
    });
    return { device: storedDevice, replayed: false };
  } finally {
    destroyProtectedDevice(commit.protectedDevice);
  }
};

const approvePairingTransaction = (
  context: PairingPersistenceContext,
  input: ApprovePairingInput,
  material: ApprovalMaterial,
): Promise<PairingApproval> =>
  context.database.transaction(async (transaction) => {
    const replay = await lockOperationAndReadReplay(
      transaction,
      input,
      material.requestFingerprint,
    );
    if (replay !== false) {
      return replay;
    }
    const pairing = await lockPendingPairing(transaction, material.humanCodeDigest);
    return commitApproval(transaction, {
      input,
      material,
      pairing,
      protectedDevice: protectDevice(context, pairing),
    });
  });

const persistApproval = async (
  context: PairingPersistenceContext,
  input: ApprovePairingInput,
): Promise<PairingApproval> => {
  if (!isValidOperationId(input.operationId)) {
    throw new PairingOperationKeyReused({});
  }
  const normalizedCode = normalizeHumanCode(input.userCode);
  const material: ApprovalMaterial = {
    humanCodeDigest: digestHumanCode(context.keys.humanCode, normalizedCode),
    requestFingerprint: fingerprintApproval(context.keys.approvalFingerprint, {
      administratorUserId: input.administratorUserId,
      method: APPROVE_PAIRING_METHOD,
      normalizedCode,
    }),
  };
  try {
    return await approvePairingTransaction(context, input, material);
  } finally {
    material.humanCodeDigest.fill(ZERO);
    material.requestFingerprint.fill(ZERO);
  }
};

const approvePairing = (
  context: PairingPersistenceContext,
  input: ApprovePairingInput,
): Effect.Effect<PairingApproval, PairingFailure> =>
  Effect.tryPromise({
    catch: normalizePairingFailure,
    try: () => persistApproval(context, input),
  });

export { approvePairing };
