import { eq } from "drizzle-orm";

import { deviceSelection } from "./pairing-devices-private.ts";
import { PairingCredentialUnavailable } from "./pairing-persistence-model-private.ts";
import type {
  PairingPersistenceContext,
  PairingPollResult,
  PairingTransaction,
  PollPairingInput,
} from "./pairing-persistence-model-private.ts";
import {
  decryptPairingDelivery,
  isUnreadablePairingDelivery,
} from "./pairing-protection-private.ts";
import { device } from "./pairing-schema.ts";

const FIRST_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;

interface StoredPollingRequest {
  readonly approvedAt: Date | null;
  readonly deliveryAuthenticationTag: Buffer | null;
  readonly deliveryCiphertext: Buffer | null;
  readonly deliveryCredentialVersion: number | null;
  readonly deliveryEnvelopeVersion: number | null;
  readonly deliveryNonce: Buffer | null;
  readonly deviceId: string | null;
  readonly expired: boolean;
  readonly expiresAt: Date;
  readonly nextPollAt: Date;
  readonly pollEligible: boolean;
  readonly status: string;
}

interface ApprovedPollingRequest extends StoredPollingRequest {
  readonly deliveryAuthenticationTag: Buffer;
  readonly deliveryCiphertext: Buffer;
  readonly deliveryCredentialVersion: number;
  readonly deliveryEnvelopeVersion: number;
  readonly deliveryNonce: Buffer;
  readonly deviceId: string;
}

interface ApprovedPairingStatusInput {
  readonly context: PairingPersistenceContext;
  readonly poll: PollPairingInput;
  readonly row: StoredPollingRequest;
  readonly transaction: PairingTransaction;
}

const requireApprovedDelivery = (row: StoredPollingRequest): ApprovedPollingRequest => {
  if (
    row.status !== "approved" ||
    row.approvedAt === null ||
    row.deviceId === null ||
    row.deliveryEnvelopeVersion === null ||
    row.deliveryCredentialVersion === null ||
    row.deliveryNonce === null ||
    row.deliveryCiphertext === null ||
    row.deliveryAuthenticationTag === null
  ) {
    throw new PairingCredentialUnavailable({});
  }
  return {
    ...row,
    deliveryAuthenticationTag: row.deliveryAuthenticationTag,
    deliveryCiphertext: row.deliveryCiphertext,
    deliveryCredentialVersion: row.deliveryCredentialVersion,
    deliveryEnvelopeVersion: row.deliveryEnvelopeVersion,
    deliveryNonce: row.deliveryNonce,
    deviceId: row.deviceId,
  };
};

const decryptCredentialSecret = (
  context: PairingPersistenceContext,
  input: PollPairingInput,
  row: ApprovedPollingRequest,
): string => {
  try {
    return decryptPairingDelivery(context.keys.deliveryEnvelope, {
      authenticationTag: row.deliveryAuthenticationTag,
      ciphertext: row.deliveryCiphertext,
      credentialVersion: row.deliveryCredentialVersion,
      deviceId: row.deviceId,
      envelopeVersion: row.deliveryEnvelopeVersion,
      nonce: row.deliveryNonce,
      pairingId: input.pairingId,
    });
  } catch (error) {
    if (isUnreadablePairingDelivery(error)) {
      throw new PairingCredentialUnavailable({});
    }
    throw error;
  }
};

const approvedPairingStatus = async (
  input: ApprovedPairingStatusInput,
): Promise<PairingPollResult> => {
  const approved = requireApprovedDelivery(input.row);
  const deviceRows = await input.transaction
    .select(deviceSelection)
    .from(device)
    .where(eq(device.id, approved.deviceId))
    .limit(SINGLE_ROW_LIMIT);
  const storedDevice = deviceRows[FIRST_INDEX];
  if (storedDevice === undefined || storedDevice.revoked) {
    throw new PairingCredentialUnavailable({});
  }
  const secret = decryptCredentialSecret(input.context, input.poll, approved);
  return {
    credential: { secret, version: approved.deliveryCredentialVersion },
    device: storedDevice,
    status: "approved",
  };
};

export { approvedPairingStatus };
export type { ApprovedPairingStatusInput, StoredPollingRequest };
