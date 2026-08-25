import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";

import type { CatalogDatabase, CatalogTransaction } from "./catalog-persistence-model-private.ts";
import {
  FIRST_ROW,
  MAXIMUM_PROVIDER_INSTANCES,
  NEXT_FAILURE,
  SQL_NULL,
  ZERO,
  activeScanMatches,
  lockedProviderScan,
  lockedScanState,
} from "./catalog-scan-model-private.ts";
import type {
  BeginCatalogScanInput,
  CatalogScanCandidate,
  CatalogScanFailureRecording,
  CatalogScanLease,
  FailCatalogScanInput,
  LockedScanState,
} from "./catalog-scan-model-private.ts";
import { providerCatalogScanState } from "./catalog-scan-schema.ts";
import type { CatalogScanStatus } from "./catalog-scan-types-private.ts";
import { providerInstance } from "./provider-schema.ts";

interface ScanResume {
  readonly continuation?: string;
  readonly failureCount: number;
}

interface WriteRunningStateInput extends BeginCatalogScanInput {
  readonly providerRevision: string;
  readonly resume: ScanResume;
}
const RUNNING_STATUS: CatalogScanStatus = "running";

const listScanCandidates = (
  database: CatalogDatabase,
): Promise<readonly CatalogScanCandidate[]> => {
  const retryReady = and(
    eq(providerCatalogScanState.status, "failed"),
    lte(providerCatalogScanState.nextRetryAt, sql`transaction_timestamp()`),
  );
  const needsScan = or(
    isNull(providerCatalogScanState.providerInstanceId),
    ne(providerCatalogScanState.capturedProviderRevision, providerInstance.revision),
    eq(providerCatalogScanState.status, "running"),
    retryReady,
  );
  const eligible = and(eq(providerInstance.enabled, true), needsScan);
  return database
    .select({
      providerInstanceId: providerInstance.id,
      revision: providerInstance.revision,
    })
    .from(providerInstance)
    .leftJoin(
      providerCatalogScanState,
      eq(providerCatalogScanState.providerInstanceId, providerInstance.id),
    )
    .where(eligible)
    .orderBy(providerInstance.createdAt, providerInstance.id)
    .limit(MAXIMUM_PROVIDER_INSTANCES);
};

const scanCanBegin = (state: LockedScanState, now: Date): boolean => {
  if (state.status === "succeeded") {
    return false;
  }
  if (state.status !== "failed") {
    return true;
  }
  return state.nextRetryAt instanceof Date && state.nextRetryAt <= now;
};
const currentScanMayBegin = (
  state: LockedScanState | undefined,
  providerRevision: string,
  now: Date,
): boolean => {
  if (state === undefined || state.capturedProviderRevision !== providerRevision) {
    return true;
  }
  return scanCanBegin(state, now);
};

const transactionTime = async (transaction: CatalogTransaction): Promise<Date> => {
  const rows = await transaction.execute<{ readonly now: Date }>(
    sql`SELECT transaction_timestamp() AS now`,
  );
  const value = rows.rows[FIRST_ROW]?.now;
  if (value === undefined) {
    throw new Error("catalog scan transaction time is unavailable");
  }
  return new Date(value);
};

const scanResume = (state: LockedScanState | undefined, providerRevision: string): ScanResume => {
  if (
    state === undefined ||
    state.capturedProviderRevision !== providerRevision ||
    state.status === "paused"
  ) {
    return { failureCount: ZERO };
  }
  if (typeof state.lastAcceptedContinuation === "string") {
    return {
      continuation: state.lastAcceptedContinuation,
      failureCount: state.consecutiveFailureCount,
    };
  }
  return { failureCount: state.consecutiveFailureCount };
};

const runningStateValues = (input: WriteRunningStateInput) => ({
  capturedProviderRevision: input.providerRevision,
  completedAt: SQL_NULL,
  consecutiveFailureCount: input.resume.failureCount,
  coreRunId: input.coreRunId,
  lastAcceptedContinuation: input.resume.continuation ?? SQL_NULL,
  nextRetryAt: SQL_NULL,
  safeFailureReason: SQL_NULL,
  startedAt: sql`transaction_timestamp()`,
  status: RUNNING_STATUS,
  updatedAt: sql`transaction_timestamp()`,
});

const writeRunningState = async (
  transaction: CatalogTransaction,
  input: WriteRunningStateInput,
): Promise<void> => {
  const values = runningStateValues(input);
  await transaction
    .insert(providerCatalogScanState)
    .values({ ...values, providerInstanceId: input.providerInstanceId })
    .onConflictDoUpdate({
      set: values,
      target: providerCatalogScanState.providerInstanceId,
    });
};

const scanLease = (input: WriteRunningStateInput): CatalogScanLease => {
  const lease = {
    failureCount: input.resume.failureCount,
    providerInstanceId: input.providerInstanceId,
    revision: input.providerRevision,
  };
  if (input.resume.continuation === undefined) {
    return lease;
  }
  return { ...lease, continuation: input.resume.continuation };
};

const beginScanTransaction = async (
  transaction: CatalogTransaction,
  input: BeginCatalogScanInput,
): Promise<CatalogScanLease | undefined> => {
  const provider = await lockedProviderScan(transaction, input.providerInstanceId);
  if (provider === undefined || !provider.enabled) {
    return undefined;
  }
  const state = await lockedScanState(transaction, input.providerInstanceId);
  const now = await transactionTime(transaction);
  if (!currentScanMayBegin(state, provider.revision, now)) {
    return undefined;
  }
  const writeInput = {
    ...input,
    providerRevision: provider.revision,
    resume: scanResume(state, provider.revision),
  };
  await writeRunningState(transaction, writeInput);
  return scanLease(writeInput);
};

const beginScan = (
  database: CatalogDatabase,
  input: BeginCatalogScanInput,
): Promise<CatalogScanLease | undefined> =>
  database.transaction((transaction) => beginScanTransaction(transaction, input));

const failScan = (
  database: CatalogDatabase,
  input: FailCatalogScanInput,
): Promise<CatalogScanFailureRecording> =>
  database.transaction(async (transaction) => {
    const provider = await lockedProviderScan(transaction, input.providerInstanceId);
    const state = await lockedScanState(transaction, input.providerInstanceId);
    if (!activeScanMatches(provider, state, input)) {
      return "stale";
    }
    await transaction
      .update(providerCatalogScanState)
      .set({
        completedAt: sql`transaction_timestamp()`,
        consecutiveFailureCount: sql`${providerCatalogScanState.consecutiveFailureCount} + ${NEXT_FAILURE}`,
        nextRetryAt: input.nextRetryAt ?? SQL_NULL,
        safeFailureReason: input.reason,
        status: "failed",
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(eq(providerCatalogScanState.providerInstanceId, input.providerInstanceId));
    return "recorded";
  });

const pauseDisabledScans = async (database: CatalogDatabase, coreRunId: string): Promise<void> => {
  await database.execute(sql`
      UPDATE ${providerCatalogScanState} AS scan
      SET captured_provider_revision = instance.revision,
          completed_at = transaction_timestamp(),
          consecutive_failure_count = 0,
          core_run_id = ${coreRunId},
          last_accepted_continuation = NULL,
          next_retry_at = NULL,
          safe_failure_reason = NULL,
          status = 'paused',
          updated_at = transaction_timestamp()
      FROM ${providerInstance} AS instance
      WHERE scan.provider_instance_id = instance.id
        AND instance.enabled = false
        AND (scan.status <> 'paused' OR scan.captured_provider_revision <> instance.revision)
    `);
};

export { beginScan, failScan, listScanCandidates, pauseDisabledScans };
