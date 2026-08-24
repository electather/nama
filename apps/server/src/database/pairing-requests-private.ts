import { and, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";

import { cleanupExpiredPairingRecords, lockPairingState } from "./pairing-cleanup-private.ts";
import { approvedPairingStatus } from "./pairing-delivery-private.ts";
import type {
  ApprovedPairingStatusInput,
  StoredPollingRequest,
} from "./pairing-delivery-private.ts";
import {
  PairingAuthenticationFailed,
  PairingCapacityReached,
  PairingCredentialUnavailable,
  PairingPollRateLimited,
  normalizePairingFailure,
} from "./pairing-persistence-model-private.ts";
import type {
  BegunPairing,
  PairingFailure,
  PairingPersistenceContext,
  PairingPollResult,
  PairingTransaction,
  PollPairingInput,
} from "./pairing-persistence-model-private.ts";
import { digestHumanCode, digestPollingToken } from "./pairing-protection-private.ts";
import { pairingRequest } from "./pairing-schema.ts";
import {
  CREDENTIAL_VERSION,
  formatHumanCode,
  isValidCredential,
  isValidPairingId,
  normalizeDisplayName,
} from "./pairing-values-private.ts";

const FIRST_INDEX = 0;
const MAXIMUM_CODE_COLLISION_ATTEMPTS = 10;
const MAXIMUM_UNEXPIRED_PAIRINGS = 100;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;
const PAIRING_CODE_COLLISION = Symbol("PairingCodeCollision");

interface PairingCreation {
  readonly displayName: string;
  readonly pairingId: string;
  readonly pollingSecret: string;
}

interface PairingInsertInput extends PairingCreation {
  readonly normalizedCode: string;
}

type PairingPollTransactionResult =
  | Readonly<{ readonly failure: InstanceType<typeof PairingCredentialUnavailable> }>
  | Readonly<{ readonly result: PairingPollResult }>;

const approvedPollTransactionResult = async (
  input: ApprovedPairingStatusInput,
): Promise<PairingPollTransactionResult> => {
  try {
    return { result: await approvedPairingStatus(input) };
  } catch (error) {
    if (error instanceof PairingCredentialUnavailable) {
      return { failure: error };
    }
    throw error;
  }
};

const admitPairing = async (transaction: PairingTransaction): Promise<void> => {
  await lockPairingState(transaction);
  await cleanupExpiredPairingRecords(transaction);
  const countRows = await transaction
    .select({ count: sql<number>`count(*)::integer` })
    .from(pairingRequest)
    .where(gt(pairingRequest.expiresAt, sql`transaction_timestamp()`));
  if ((countRows[FIRST_INDEX]?.count ?? ZERO) >= MAXIMUM_UNEXPIRED_PAIRINGS) {
    throw new PairingCapacityReached({});
  }
};

const insertPairingRequest = async (
  context: PairingPersistenceContext,
  input: PairingInsertInput,
): Promise<BegunPairing | typeof PAIRING_CODE_COLLISION> => {
  const humanCodeDigest = digestHumanCode(context.keys.humanCode, input.normalizedCode);
  const pollingTokenDigest = digestPollingToken(context.keys.pollingToken, {
    pairingId: input.pairingId,
    secret: input.pollingSecret,
    version: CREDENTIAL_VERSION,
  });
  try {
    return await context.database.transaction(async (transaction) => {
      await admitPairing(transaction);
      const inserted = await transaction
        .insert(pairingRequest)
        .values({
          displayName: input.displayName,
          expiresAt: sql`transaction_timestamp() + interval '10 minutes'`,
          humanCodeDigest,
          humanCodeVersion: CREDENTIAL_VERSION,
          id: input.pairingId,
          nextPollAt: sql`transaction_timestamp() + interval '5 seconds'`,
          pollingTokenDigest,
          pollingTokenVersion: CREDENTIAL_VERSION,
          retainedUntil: sql`transaction_timestamp() + interval '24 hours 10 minutes'`,
        })
        .onConflictDoNothing({ target: pairingRequest.humanCodeDigest })
        .returning({ expiresAt: pairingRequest.expiresAt });
      const row = inserted[FIRST_INDEX];
      if (row === undefined) {
        return PAIRING_CODE_COLLISION;
      }
      return {
        displayName: input.displayName,
        expiresAt: row.expiresAt,
        id: input.pairingId,
        pollingToken: { secret: input.pollingSecret, version: CREDENTIAL_VERSION },
        userCode: formatHumanCode(input.normalizedCode),
      };
    });
  } finally {
    humanCodeDigest.fill(ZERO);
    pollingTokenDigest.fill(ZERO);
  }
};

const createPairingWithUniqueCode = async (
  context: PairingPersistenceContext,
  input: PairingCreation,
  attempt = ZERO,
): Promise<BegunPairing> => {
  if (attempt >= MAXIMUM_CODE_COLLISION_ATTEMPTS) {
    throw new Error("pairing code collision retry exhausted");
  }
  const pairing = await insertPairingRequest(context, {
    ...input,
    normalizedCode: context.values.humanCode(),
  });
  if (pairing !== PAIRING_CODE_COLLISION) {
    return pairing;
  }
  return createPairingWithUniqueCode(context, input, attempt + SINGLE_ROW_LIMIT);
};

const beginPairing = (context: PairingPersistenceContext, displayNameInput: string) =>
  Effect.tryPromise({
    catch: normalizePairingFailure,
    try: () =>
      createPairingWithUniqueCode(context, {
        displayName: normalizeDisplayName(displayNameInput),
        pairingId: context.values.pairingId(),
        pollingSecret: context.values.secret(),
      }),
  });

const lockPollingRequest = async (
  transaction: PairingTransaction,
  input: PollPairingInput,
  pollingTokenDigest: Buffer,
): Promise<StoredPollingRequest> => {
  const rows = await transaction
    .select({
      approvedAt: pairingRequest.approvedAt,
      deliveryAuthenticationTag: pairingRequest.deliveryAuthenticationTag,
      deliveryCiphertext: pairingRequest.deliveryCiphertext,
      deliveryCredentialVersion: pairingRequest.deliveryCredentialVersion,
      deliveryEnvelopeVersion: pairingRequest.deliveryEnvelopeVersion,
      deliveryNonce: pairingRequest.deliveryNonce,
      deviceId: pairingRequest.deviceId,
      expired: sql<boolean>`${pairingRequest.expiresAt} <= transaction_timestamp()`,
      expiresAt: pairingRequest.expiresAt,
      nextPollAt: pairingRequest.nextPollAt,
      pollEligible: sql<boolean>`${pairingRequest.nextPollAt} <= transaction_timestamp()`,
      status: pairingRequest.status,
    })
    .from(pairingRequest)
    .where(
      and(
        eq(pairingRequest.id, input.pairingId),
        eq(pairingRequest.pollingTokenVersion, input.pollingToken.version),
        eq(pairingRequest.pollingTokenDigest, pollingTokenDigest),
      ),
    )
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  const row = rows[FIRST_INDEX];
  if (row === undefined) {
    throw new PairingAuthenticationFailed({});
  }
  return row;
};

const pollPairingTransaction = async (
  context: PairingPersistenceContext,
  input: PollPairingInput,
  pollingTokenDigest: Buffer,
): Promise<PairingPollResult> => {
  const outcome = await context.database.transaction(
    async (transaction): Promise<PairingPollTransactionResult> => {
      const row = await lockPollingRequest(transaction, input, pollingTokenDigest);
      if (row.expired) {
        return { result: { status: "expired" } };
      }
      if (!row.pollEligible) {
        throw new PairingPollRateLimited({ retryAt: row.nextPollAt });
      }
      await transaction
        .update(pairingRequest)
        .set({
          nextPollAt: sql`least(${pairingRequest.expiresAt}, transaction_timestamp() + interval '5 seconds')`,
        })
        .where(eq(pairingRequest.id, input.pairingId));
      if (row.status === "pending") {
        return { result: { status: "pending" } };
      }
      return approvedPollTransactionResult({ context, poll: input, row, transaction });
    },
  );
  if ("failure" in outcome) {
    throw outcome.failure;
  }
  return outcome.result;
};

const persistPairingPoll = async (
  context: PairingPersistenceContext,
  input: PollPairingInput,
): Promise<PairingPollResult> => {
  if (
    !isValidPairingId(input.pairingId) ||
    !isValidCredential(input.pollingToken.version, input.pollingToken.secret)
  ) {
    throw new PairingAuthenticationFailed({});
  }
  const pollingTokenDigest = digestPollingToken(context.keys.pollingToken, {
    pairingId: input.pairingId,
    secret: input.pollingToken.secret,
    version: input.pollingToken.version,
  });
  try {
    return await pollPairingTransaction(context, input, pollingTokenDigest);
  } finally {
    pollingTokenDigest.fill(ZERO);
  }
};

const pollPairing = (
  context: PairingPersistenceContext,
  input: PollPairingInput,
): Effect.Effect<PairingPollResult, PairingFailure> =>
  Effect.tryPromise({
    catch: normalizePairingFailure,
    try: () => persistPairingPoll(context, input),
  });

export { beginPairing, pollPairing };
