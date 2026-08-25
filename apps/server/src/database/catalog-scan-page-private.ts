import { and, eq, inArray, sql } from "drizzle-orm";

import { providerCatalogScanState, providerItemMapping } from "./catalog-item-schema.ts";
import { replaceCanonicalItemInTransaction } from "./catalog-mutations-private.ts";
import type { CatalogDatabase, CatalogTransaction } from "./catalog-persistence-model-private.ts";
import {
  FIRST_ROW,
  SINGLE_ROW_LIMIT,
  SQL_NULL,
  ZERO,
  activeScanMatches,
  lockedProviderScan,
  lockedScanState,
  validPageBoundary,
} from "./catalog-scan-model-private.ts";
import type {
  AcceptCatalogPageInput,
  CatalogPageAcceptance,
  ResolveCatalogPageInput,
  RestartCatalogScanInput,
} from "./catalog-scan-model-private.ts";
import type { CatalogScanStatus } from "./catalog-scan-types-private.ts";

const acceptedPageStatus = (complete: boolean): CatalogScanStatus => {
  if (complete) {
    return "succeeded";
  }
  return "running";
};

const acceptedPageCompletedAt = (complete: boolean) => {
  if (complete) {
    return sql`transaction_timestamp()`;
  }
  return SQL_NULL;
};

const acceptedPageValues = (input: AcceptCatalogPageInput) => ({
  completedAt: acceptedPageCompletedAt(input.complete),
  consecutiveFailureCount: ZERO,
  lastAcceptedContinuation: input.nextContinuation ?? SQL_NULL,
  nextRetryAt: SQL_NULL,
  safeFailureReason: SQL_NULL,
  status: acceptedPageStatus(input.complete),
  updatedAt: sql`transaction_timestamp()`,
});

const acceptPageTransaction = async (
  transaction: CatalogTransaction,
  input: AcceptCatalogPageInput,
): Promise<CatalogPageAcceptance> => {
  const provider = await lockedProviderScan(transaction, input.providerInstanceId);
  const state = await lockedScanState(transaction, input.providerInstanceId);
  if (!activeScanMatches(provider, state, input)) {
    return "stale";
  }
  for (const item of input.items) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- One transaction must observe plugin items in page order; parallel use of its connection is unsafe.
    await replaceCanonicalItemInTransaction(transaction, {
      ...item,
      lastSeenScanRunId: input.coreRunId,
    });
  }
  await transaction
    .update(providerCatalogScanState)
    .set(acceptedPageValues(input))
    .where(eq(providerCatalogScanState.providerInstanceId, input.providerInstanceId));
  return "accepted";
};

const acceptPage = (
  database: CatalogDatabase,
  input: AcceptCatalogPageInput,
): Promise<CatalogPageAcceptance> => {
  if (!validPageBoundary(input.complete, input.nextContinuation)) {
    return Promise.reject(new Error("catalog page continuation is inconsistent"));
  }
  if (input.items.some((item) => item.providerInstanceId !== input.providerInstanceId)) {
    return Promise.reject(new Error("catalog page item provider does not match scan"));
  }
  return database.transaction((transaction) => acceptPageTransaction(transaction, input));
};

const restartScan = (
  database: CatalogDatabase,
  input: RestartCatalogScanInput,
): Promise<CatalogPageAcceptance> =>
  database.transaction(async (transaction) => {
    const provider = await lockedProviderScan(transaction, input.providerInstanceId);
    const state = await lockedScanState(transaction, input.providerInstanceId);
    if (!activeScanMatches(provider, state, input)) {
      return "stale";
    }
    await transaction
      .update(providerCatalogScanState)
      .set({
        completedAt: SQL_NULL,
        consecutiveFailureCount: ZERO,
        lastAcceptedContinuation: SQL_NULL,
        nextRetryAt: SQL_NULL,
        safeFailureReason: SQL_NULL,
        startedAt: sql`transaction_timestamp()`,
        status: "running",
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(eq(providerCatalogScanState.providerInstanceId, input.providerInstanceId));
    return "accepted";
  });

interface ResolvedScanState {
  readonly capturedProviderRevision: string;
  readonly coreRunId: string;
  readonly lastAcceptedContinuation: string | null;
  readonly status: CatalogScanStatus;
}

const pageBoundaryMatches = (
  state: ResolvedScanState | undefined,
  input: ResolveCatalogPageInput,
): boolean => {
  if (input.complete) {
    return state?.status === "succeeded" && typeof state.lastAcceptedContinuation !== "string";
  }
  return state?.status === "running" && state.lastAcceptedContinuation === input.nextContinuation;
};

const scanStateMatches = (
  state: ResolvedScanState | undefined,
  input: ResolveCatalogPageInput,
): boolean =>
  state?.capturedProviderRevision === input.revision &&
  state.coreRunId === input.coreRunId &&
  pageBoundaryMatches(state, input);

const resolvedScanState = async (
  database: CatalogDatabase,
  providerInstanceId: string,
): Promise<ResolvedScanState | undefined> => {
  const rows = await database
    .select({
      capturedProviderRevision: providerCatalogScanState.capturedProviderRevision,
      coreRunId: providerCatalogScanState.coreRunId,
      lastAcceptedContinuation: providerCatalogScanState.lastAcceptedContinuation,
      status: providerCatalogScanState.status,
    })
    .from(providerCatalogScanState)
    .where(eq(providerCatalogScanState.providerInstanceId, providerInstanceId))
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const allPageMappingsExist = async (
  database: CatalogDatabase,
  input: ResolveCatalogPageInput,
): Promise<boolean> => {
  const uniqueReferences = [...new Set(input.itemReferences)];
  if (uniqueReferences.length === ZERO) {
    return true;
  }
  const providerMatches = eq(providerItemMapping.providerInstanceId, input.providerInstanceId);
  const runMatches = eq(providerItemMapping.lastSeenScanRunId, input.coreRunId);
  const referencesMatch = inArray(providerItemMapping.itemReference, uniqueReferences);
  const mappings = await database
    .select({ itemReference: providerItemMapping.itemReference })
    .from(providerItemMapping)
    .where(and(providerMatches, runMatches, referencesMatch));
  return mappings.length === uniqueReferences.length;
};

const resolvePageAcceptance = async (
  database: CatalogDatabase,
  input: ResolveCatalogPageInput,
): Promise<boolean> => {
  if (!validPageBoundary(input.complete, input.nextContinuation)) {
    return false;
  }
  const state = await resolvedScanState(database, input.providerInstanceId);
  if (!scanStateMatches(state, input)) {
    return false;
  }
  return allPageMappingsExist(database, input);
};

export { acceptPage, resolvePageAcceptance, restartScan };
