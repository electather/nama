import { eq, sql } from "drizzle-orm";

import { providerCatalogScanState } from "./catalog-item-schema.ts";
import type {
  CatalogItemObservation,
  CatalogTransaction,
} from "./catalog-persistence-model-private.ts";
import type { CatalogScanStatus } from "./catalog-scan-types-private.ts";
import { providerInstance } from "./provider-schema.ts";

const FIRST_ROW = 0;
const MAXIMUM_PROVIDER_INSTANCES = 100;
const NEXT_FAILURE = 1;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;
const SQL_NULL = sql`null`;

type CatalogFreshness = "empty" | "not_ready" | "ready";
type CatalogPageAcceptance = "accepted" | "stale";
type CatalogScanFailureRecording = "recorded" | "stale";
type CatalogScanFailureReason =
  | "authentication_failed"
  | "capability_incompatible"
  | "credentials_unavailable"
  | "database_unavailable"
  | "invalid_response"
  | "plugin_unavailable"
  | "provider_unavailable";

interface CatalogScanCandidate {
  readonly providerInstanceId: string;
  readonly revision: string;
}

interface CatalogScanLease extends CatalogScanCandidate {
  readonly continuation?: string;
  readonly failureCount: number;
}

interface BeginCatalogScanInput {
  readonly coreRunId: string;
  readonly providerInstanceId: string;
}

interface AcceptCatalogPageInput extends CatalogScanCandidate {
  readonly complete: boolean;
  readonly coreRunId: string;
  readonly items: readonly CatalogItemObservation[];
  readonly nextContinuation?: string;
}

interface FailCatalogScanInput extends CatalogScanCandidate {
  readonly coreRunId: string;
  readonly nextRetryAt?: Date;
  readonly reason: CatalogScanFailureReason;
}

interface RestartCatalogScanInput extends CatalogScanCandidate {
  readonly coreRunId: string;
}

interface ResolveCatalogPageInput extends CatalogScanCandidate {
  readonly complete: boolean;
  readonly coreRunId: string;
  readonly itemReferences: readonly string[];
  readonly nextContinuation?: string;
}

interface LockedProviderScan {
  readonly enabled: boolean;
  readonly revision: string;
}

interface LockedScanState {
  readonly capturedProviderRevision: string;
  readonly consecutiveFailureCount: number;
  readonly coreRunId: string;
  readonly lastAcceptedContinuation: string | null;
  readonly nextRetryAt: Date | null;
  readonly status: CatalogScanStatus;
}

const lockedProviderScan = async (
  transaction: CatalogTransaction,
  providerInstanceId: string,
): Promise<LockedProviderScan | undefined> => {
  const rows = await transaction
    .select({ enabled: providerInstance.enabled, revision: providerInstance.revision })
    .from(providerInstance)
    .where(eq(providerInstance.id, providerInstanceId))
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const lockedScanState = async (
  transaction: CatalogTransaction,
  providerInstanceId: string,
): Promise<LockedScanState | undefined> => {
  const rows = await transaction
    .select({
      capturedProviderRevision: providerCatalogScanState.capturedProviderRevision,
      consecutiveFailureCount: providerCatalogScanState.consecutiveFailureCount,
      coreRunId: providerCatalogScanState.coreRunId,
      lastAcceptedContinuation: providerCatalogScanState.lastAcceptedContinuation,
      nextRetryAt: providerCatalogScanState.nextRetryAt,
      status: providerCatalogScanState.status,
    })
    .from(providerCatalogScanState)
    .where(eq(providerCatalogScanState.providerInstanceId, providerInstanceId))
    .for("update")
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const activeScanMatches = (
  provider: LockedProviderScan | undefined,
  state: LockedScanState | undefined,
  input: CatalogScanCandidate & { readonly coreRunId: string },
): boolean =>
  provider?.enabled === true &&
  provider.revision === input.revision &&
  state?.capturedProviderRevision === input.revision &&
  state.coreRunId === input.coreRunId &&
  state.status === "running";

const validPageBoundary = (complete: boolean, nextContinuation: string | undefined): boolean => {
  if (complete) {
    return nextContinuation === undefined;
  }
  return nextContinuation !== undefined;
};

export {
  FIRST_ROW,
  MAXIMUM_PROVIDER_INSTANCES,
  NEXT_FAILURE,
  SINGLE_ROW_LIMIT,
  SQL_NULL,
  ZERO,
  activeScanMatches,
  lockedProviderScan,
  lockedScanState,
  validPageBoundary,
};
export type {
  AcceptCatalogPageInput,
  BeginCatalogScanInput,
  CatalogFreshness,
  CatalogPageAcceptance,
  CatalogScanCandidate,
  CatalogScanFailureReason,
  CatalogScanFailureRecording,
  CatalogScanLease,
  FailCatalogScanInput,
  LockedProviderScan,
  LockedScanState,
  ResolveCatalogPageInput,
  RestartCatalogScanInput,
};
