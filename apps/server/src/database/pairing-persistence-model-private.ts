import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data } from "effect";
import type { Effect } from "effect";

import type { PairingProtectionKeys } from "./pairing-protection-private.ts";
import type { databaseSchema } from "./schema.ts";

interface DeviceRecord {
  readonly createdAt: Date;
  readonly displayName: string;
  readonly id: string;
  readonly lastSeenAt: Date | null;
  readonly revoked: boolean;
  readonly revokedAt: Date | null;
}

interface PairingCredential {
  readonly secret: string;
  readonly version: number;
}

interface BeginPairingInput {
  readonly displayName: string;
}

interface BegunPairing {
  readonly displayName: string;
  readonly expiresAt: Date;
  readonly id: string;
  readonly pollingToken: PairingCredential;
  readonly userCode: string;
}

interface PollPairingInput {
  readonly pairingId: string;
  readonly pollingToken: PairingCredential;
}

type PairingPollResult =
  | Readonly<{ readonly status: "expired" | "pending" }>
  | Readonly<{
      readonly credential: PairingCredential;
      readonly device: DeviceRecord;
      readonly status: "approved";
    }>;

interface ApprovePairingInput {
  readonly administratorUserId: string;
  readonly operationId: string;
  readonly userCode: string;
}

interface PairingApproval {
  readonly device: DeviceRecord;
  readonly replayed: boolean;
}

interface PairingValueSource {
  readonly deviceId: () => string;
  readonly humanCode: () => string;
  readonly pairingId: () => string;
  readonly secret: () => string;
}

type PairingDatabase = NodePgDatabase<typeof databaseSchema>;
type FirstTupleElement<Tuple extends readonly unknown[]> = Tuple extends readonly [
  infer First,
  ...(readonly unknown[]),
]
  ? First
  : never;
type PairingTransactionCallback = FirstTupleElement<Parameters<PairingDatabase["transaction"]>>;
type PairingTransaction = FirstTupleElement<Parameters<PairingTransactionCallback>>;

interface PairingPersistenceContext {
  readonly database: PairingDatabase;
  readonly keys: PairingProtectionKeys;
  readonly values: PairingValueSource;
}

const taggedError = Data.TaggedError;
const PairingPersistenceError = taggedError("PairingPersistenceError")<Record<string, never>>;
const PairingCapacityReached = taggedError("PairingCapacityReached")<Record<string, never>>;
const PairingDisplayNameInvalid = taggedError("PairingDisplayNameInvalid")<Record<string, never>>;
const PairingAuthenticationFailed = taggedError("PairingAuthenticationFailed")<
  Record<string, never>
>;
const PairingPollRateLimited = taggedError("PairingPollRateLimited")<{
  readonly retryAt: Date;
}>;
const PairingCodeInvalid = taggedError("PairingCodeInvalid")<Record<string, never>>;
const PairingExpired = taggedError("PairingExpired")<Record<string, never>>;
const PairingAlreadyApproved = taggedError("PairingAlreadyApproved")<Record<string, never>>;
const PairingOperationKeyReused = taggedError("PairingOperationKeyReused")<Record<string, never>>;
const PairingCredentialUnavailable = taggedError("PairingCredentialUnavailable")<
  Record<string, never>
>;

type PairingPersistenceFailure = InstanceType<typeof PairingPersistenceError>;
type PairingFailure =
  | PairingPersistenceFailure
  | InstanceType<typeof PairingCapacityReached>
  | InstanceType<typeof PairingDisplayNameInvalid>
  | InstanceType<typeof PairingAuthenticationFailed>
  | InstanceType<typeof PairingPollRateLimited>
  | InstanceType<typeof PairingCodeInvalid>
  | InstanceType<typeof PairingExpired>
  | InstanceType<typeof PairingAlreadyApproved>
  | InstanceType<typeof PairingOperationKeyReused>
  | InstanceType<typeof PairingCredentialUnavailable>;

interface PairingPersistence {
  readonly approvePairing: (
    input: ApprovePairingInput,
  ) => Effect.Effect<PairingApproval, PairingFailure>;
  readonly beginPairing: (input: BeginPairingInput) => Effect.Effect<BegunPairing, PairingFailure>;
  readonly cleanupExpired: Effect.Effect<void, PairingPersistenceFailure>;
  readonly cleanupHealthy: () => boolean;
  readonly pollPairing: (
    input: PollPairingInput,
  ) => Effect.Effect<PairingPollResult, PairingFailure>;
  readonly recordDeviceSeen: (
    deviceId: string,
  ) => Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure>;
  readonly revokeDevice: (
    deviceId: string,
  ) => Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure>;
  readonly verifyDeviceCredential: (
    credential: PairingCredential,
  ) => Effect.Effect<DeviceRecord | undefined, PairingPersistenceFailure>;
}

const PAIRING_FAILURE_CLASSES = [
  PairingCapacityReached,
  PairingDisplayNameInvalid,
  PairingAuthenticationFailed,
  PairingPollRateLimited,
  PairingCodeInvalid,
  PairingExpired,
  PairingAlreadyApproved,
  PairingOperationKeyReused,
  PairingCredentialUnavailable,
  PairingPersistenceError,
] as const;

const pairingPersistenceFailure = (): PairingPersistenceFailure => new PairingPersistenceError({});

const isPairingFailure = (error: unknown): error is PairingFailure =>
  PAIRING_FAILURE_CLASSES.some((FailureClass) => error instanceof FailureClass);

const normalizePairingFailure = (error: unknown): PairingFailure => {
  if (isPairingFailure(error)) {
    return error;
  }
  return pairingPersistenceFailure();
};

export {
  type ApprovePairingInput,
  type BeginPairingInput,
  type BegunPairing,
  type DeviceRecord,
  type FirstTupleElement,
  type PairingApproval,
  type PairingCredential,
  type PairingDatabase,
  type PairingTransactionCallback,
  type PairingTransaction,
  type PairingFailure,
  type PairingPersistence,
  type PairingPersistenceContext,
  type PairingPersistenceFailure,
  type PairingPollResult,
  type PairingValueSource,
  type PollPairingInput,
  PairingAlreadyApproved,
  PairingAuthenticationFailed,
  PairingCapacityReached,
  PairingCodeInvalid,
  PairingCredentialUnavailable,
  PairingDisplayNameInvalid,
  PairingExpired,
  PairingOperationKeyReused,
  PairingPollRateLimited,
  normalizePairingFailure,
  pairingPersistenceFailure,
};
