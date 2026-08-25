import { Effect } from "effect";

import { replaceCanonicalItem } from "./catalog-mutations-private.ts";
import { catalogPersistenceFailure } from "./catalog-persistence-model-private.ts";
import type {
  CatalogDatabase,
  CatalogItemObservation,
  CatalogPersistenceFailure,
  StoredCatalogItem,
} from "./catalog-persistence-model-private.ts";
import { loadItem } from "./catalog-reads-private.ts";
import {
  acceptPage,
  beginScan,
  failScan,
  freshness,
  listScanCandidates,
  pauseDisabledScans,
  resolvePageAcceptance,
  restartScan,
} from "./catalog-scan-private.ts";
import type {
  AcceptCatalogPageInput,
  BeginCatalogScanInput,
  CatalogFreshness,
  CatalogPageAcceptance,
  CatalogScanCandidate,
  CatalogScanFailureReason,
  CatalogScanFailureRecording,
  CatalogScanLease,
  FailCatalogScanInput,
  ResolveCatalogPageInput,
  RestartCatalogScanInput,
} from "./catalog-scan-private.ts";

interface CatalogPersistence {
  readonly acceptPage: (
    input: AcceptCatalogPageInput,
  ) => Effect.Effect<CatalogPageAcceptance, CatalogPersistenceFailure>;
  readonly beginScan: (
    input: BeginCatalogScanInput,
  ) => Effect.Effect<CatalogScanLease | undefined, CatalogPersistenceFailure>;
  readonly failScan: (
    input: FailCatalogScanInput,
  ) => Effect.Effect<CatalogScanFailureRecording, CatalogPersistenceFailure>;
  readonly freshness: Effect.Effect<CatalogFreshness, CatalogPersistenceFailure>;
  readonly listScanCandidates: Effect.Effect<
    readonly CatalogScanCandidate[],
    CatalogPersistenceFailure
  >;
  readonly loadItem: (
    canonicalItemId: string,
  ) => Effect.Effect<StoredCatalogItem | undefined, CatalogPersistenceFailure>;
  readonly observeItem: (
    input: CatalogItemObservation,
  ) => Effect.Effect<StoredCatalogItem, CatalogPersistenceFailure>;
  readonly pauseDisabledScans: (
    coreRunId: string,
  ) => Effect.Effect<void, CatalogPersistenceFailure>;
  readonly resolvePageAcceptance: (
    input: ResolveCatalogPageInput,
  ) => Effect.Effect<boolean, CatalogPersistenceFailure>;
  readonly restartScan: (
    input: RestartCatalogScanInput,
  ) => Effect.Effect<CatalogPageAcceptance, CatalogPersistenceFailure>;
}

type CatalogScanPersistence = Pick<
  CatalogPersistence,
  | "acceptPage"
  | "beginScan"
  | "failScan"
  | "freshness"
  | "listScanCandidates"
  | "pauseDisabledScans"
  | "resolvePageAcceptance"
  | "restartScan"
>;

const makeCatalogScanPersistence = (database: CatalogDatabase): CatalogScanPersistence => ({
  acceptPage: (input: AcceptCatalogPageInput) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => acceptPage(database, input),
    }),
  beginScan: (input: BeginCatalogScanInput) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => beginScan(database, input),
    }),
  failScan: (input: FailCatalogScanInput) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => failScan(database, input),
    }),
  freshness: Effect.tryPromise({
    catch: catalogPersistenceFailure,
    try: () => freshness(database),
  }),
  listScanCandidates: Effect.tryPromise({
    catch: catalogPersistenceFailure,
    try: () => listScanCandidates(database),
  }),
  pauseDisabledScans: (coreRunId: string) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => pauseDisabledScans(database, coreRunId),
    }),
  resolvePageAcceptance: (input: ResolveCatalogPageInput) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => resolvePageAcceptance(database, input),
    }),
  restartScan: (input: RestartCatalogScanInput) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => restartScan(database, input),
    }),
});

const makeCatalogPersistence = (database: CatalogDatabase): CatalogPersistence => ({
  ...makeCatalogScanPersistence(database),
  loadItem: (canonicalItemId: string) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => loadItem(database, canonicalItemId),
    }),
  observeItem: (input: CatalogItemObservation) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: async () => {
        const canonicalItemId = await replaceCanonicalItem(database, input);
        const stored = await loadItem(database, canonicalItemId);
        if (stored === undefined) {
          throw new Error("committed canonical catalog item is missing");
        }
        return stored;
      },
    }),
});

export {
  type AcceptCatalogPageInput,
  type BeginCatalogScanInput,
  type CatalogFreshness,
  type CatalogItemObservation,
  type CatalogPageAcceptance,
  type CatalogPersistence,
  type CatalogScanCandidate,
  type CatalogScanFailureReason,
  type CatalogScanFailureRecording,
  type CatalogScanLease,
  type FailCatalogScanInput,
  type RestartCatalogScanInput,
  type ResolveCatalogPageInput,
  makeCatalogPersistence,
};
