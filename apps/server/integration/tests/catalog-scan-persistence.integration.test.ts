// oxlint-disable eslint/max-lines-per-function, eslint/no-magic-numbers, unicorn/no-null -- These disposable-PostgreSQL scenarios keep each durable scan transition and exact SQL-null assertion visible in execution order.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { CatalogItemObservation } from "../../src/database/catalog-persistence.ts";
import { initializeCatalogDatabase, movieObservation } from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const PROVIDER_INSTANCE_ID = "catalog-scan-provider";
const CAPTURED_REVISION = `${PROVIDER_INSTANCE_ID}-revision`;
const CORE_RUN_ID = "catalog-core-run";
const RESTARTED_CORE_RUN_ID = "catalog-core-run-restarted";
const NEXT_CONTINUATION = "private-next-continuation";
const FUTURE_RETRY = new Date("2099-01-01T00:00:00.000Z");

const initializeScanDatabase = (databaseUrl: string) =>
  initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);

const catalogState = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly captured_provider_revision: string;
        readonly completed_at: Date | null;
        readonly consecutive_failure_count: number;
        readonly core_run_id: string;
        readonly last_accepted_continuation: string | null;
        readonly next_retry_at: Date | null;
        readonly safe_failure_reason: string | null;
        readonly status: string;
      }>(
        `SELECT captured_provider_revision, completed_at, consecutive_failure_count,
                core_run_id, last_accepted_continuation, next_retry_at,
                safe_failure_reason, status
         FROM provider_catalog_scan_state
         WHERE provider_instance_id = $1`,
        [PROVIDER_INSTANCE_ID],
      ),
    ),
  );

const catalogCounts = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{ readonly item_count: number; readonly mapping_count: number }>(
        `SELECT
           (SELECT count(*)::integer FROM canonical_item) AS item_count,
           (SELECT count(*)::integer FROM provider_item_mapping) AS mapping_count`,
      ),
    ),
  );

it.live("resumes one durable scan without run history", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* durableCatalogScanState() {
      yield* initializeScanDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* exerciseScanState() {
          expect(yield* database.catalog.listScanCandidates).toEqual([
            { providerInstanceId: PROVIDER_INSTANCE_ID, revision: CAPTURED_REVISION },
          ]);

          const initial = yield* database.catalog.beginScan({
            coreRunId: CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          expect(initial).toEqual({
            continuation: undefined,
            failureCount: 0,
            providerInstanceId: PROVIDER_INSTANCE_ID,
            revision: CAPTURED_REVISION,
          });
          if (initial === undefined) {
            throw new Error("initial catalog scan was not admitted");
          }

          expect(
            yield* database.catalog.acceptPage({
              complete: false,
              coreRunId: CORE_RUN_ID,
              items: [movieObservation(PROVIDER_INSTANCE_ID)],
              nextContinuation: NEXT_CONTINUATION,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            }),
          ).toBe("accepted");

          const resumed = yield* database.catalog.beginScan({
            coreRunId: RESTARTED_CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          expect(resumed).toEqual({
            continuation: NEXT_CONTINUATION,
            failureCount: 0,
            providerInstanceId: PROVIDER_INSTANCE_ID,
            revision: CAPTURED_REVISION,
          });

          expect(
            yield* database.catalog.acceptPage({
              complete: true,
              coreRunId: RESTARTED_CORE_RUN_ID,
              items: [movieObservation(PROVIDER_INSTANCE_ID)],
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            }),
          ).toBe("accepted");
          expect(
            yield* database.catalog.beginScan({
              coreRunId: "third-core-run",
              providerInstanceId: PROVIDER_INSTANCE_ID,
            }),
          ).toBeUndefined();
        }),
      );

      const state = yield* catalogState(databaseUrl);
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]).toMatchObject({
        captured_provider_revision: CAPTURED_REVISION,
        consecutive_failure_count: 0,
        core_run_id: RESTARTED_CORE_RUN_ID,
        last_accepted_continuation: null,
        next_retry_at: null,
        safe_failure_reason: null,
        status: "succeeded",
      });
      expect(state.rows[0]?.completed_at).toBeInstanceOf(Date);
      expect(yield* catalogCounts(databaseUrl)).toMatchObject({
        rows: [{ item_count: 1, mapping_count: 1 }],
      });
    }),
  ),
);

it.live("commits a complete page and continuation atomically while rejecting stale revisions", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* atomicCatalogPage() {
      yield* initializeScanDatabase(databaseUrl);
      const movie = movieObservation(PROVIDER_INSTANCE_ID);
      const changedKind: CatalogItemObservation = {
        ...movie,
        episodeCount: 1,
        firstReleaseDate: "2026-01-01",
        itemReference: movie.itemReference,
        kind: "show",
        lastReleaseDate: "2026-12-31",
        seasonCount: 1,
      };
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* rejectPartialPage() {
          yield* database.catalog.beginScan({
            coreRunId: CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          yield* database.catalog
            .acceptPage({
              complete: false,
              coreRunId: CORE_RUN_ID,
              items: [movie, changedKind],
              nextContinuation: NEXT_CONTINUATION,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            })
            .pipe(Effect.flip);
        }),
      );

      expect(yield* catalogCounts(databaseUrl)).toMatchObject({
        rows: [{ item_count: 0, mapping_count: 0 }],
      });
      expect(yield* catalogState(databaseUrl)).toMatchObject({
        rows: [{ last_accepted_continuation: null, status: "running" }],
      });

      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `UPDATE provider_instance
             SET revision = 'replacement-revision'
             WHERE id = $1`,
            [PROVIDER_INSTANCE_ID],
          ),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* rejectStalePage() {
          expect(
            yield* database.catalog.acceptPage({
              complete: true,
              coreRunId: CORE_RUN_ID,
              items: [movie],
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            }),
          ).toBe("stale");
        }),
      );
      expect(yield* catalogCounts(databaseUrl)).toMatchObject({
        rows: [{ item_count: 0, mapping_count: 0 }],
      });
    }),
  ),
);

it.live("persists retry progress and resets backoff after page acceptance", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* persistedCatalogRetry() {
      yield* initializeScanDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* exerciseCatalogRetry() {
          yield* database.catalog.beginScan({
            coreRunId: CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          expect(
            yield* database.catalog.failScan({
              coreRunId: CORE_RUN_ID,
              nextRetryAt: FUTURE_RETRY,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              reason: "provider_unavailable",
              revision: CAPTURED_REVISION,
            }),
          ).toBe("recorded");
          expect(yield* database.catalog.listScanCandidates).toEqual([]);
        }),
      );

      expect(yield* catalogState(databaseUrl)).toMatchObject({
        rows: [
          {
            consecutive_failure_count: 1,
            last_accepted_continuation: null,
            next_retry_at: FUTURE_RETRY,
            safe_failure_reason: "provider_unavailable",
            status: "failed",
          },
        ],
      });

      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `UPDATE provider_catalog_scan_state
             SET next_retry_at = transaction_timestamp() - interval '1 second'
             WHERE provider_instance_id = $1`,
            [PROVIDER_INSTANCE_ID],
          ),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* resumeCatalogRetry() {
          const retry = yield* database.catalog.beginScan({
            coreRunId: RESTARTED_CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          expect(retry?.failureCount).toBe(1);
          yield* database.catalog.acceptPage({
            complete: false,
            coreRunId: RESTARTED_CORE_RUN_ID,
            items: [movieObservation(PROVIDER_INSTANCE_ID)],
            nextContinuation: NEXT_CONTINUATION,
            providerInstanceId: PROVIDER_INSTANCE_ID,
            revision: CAPTURED_REVISION,
          });
          expect(
            yield* database.catalog.failScan({
              coreRunId: RESTARTED_CORE_RUN_ID,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              reason: "invalid_response",
              revision: CAPTURED_REVISION,
            }),
          ).toBe("recorded");
          expect(yield* database.catalog.listScanCandidates).toEqual([]);
        }),
      );
      expect(yield* catalogState(databaseUrl)).toMatchObject({
        rows: [
          {
            consecutive_failure_count: 1,
            last_accepted_continuation: NEXT_CONTINUATION,
            next_retry_at: null,
            safe_failure_reason: "invalid_response",
            status: "failed",
          },
        ],
      });
    }),
  ),
);

it.live("pauses disabled scans and starts re-enabled revisions from the beginning", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* pausedCatalogScan() {
      yield* initializeScanDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* beginCatalogBeforeDisable() {
          yield* database.catalog.beginScan({
            coreRunId: CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          yield* database.catalog.acceptPage({
            complete: false,
            coreRunId: CORE_RUN_ID,
            items: [movieObservation(PROVIDER_INSTANCE_ID)],
            nextContinuation: NEXT_CONTINUATION,
            providerInstanceId: PROVIDER_INSTANCE_ID,
            revision: CAPTURED_REVISION,
          });
        }),
      );
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `UPDATE provider_instance
             SET enabled = false, revision = 'disabled-revision'
             WHERE id = $1`,
            [PROVIDER_INSTANCE_ID],
          ),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.pauseDisabledScans(CORE_RUN_ID),
      );
      expect(yield* catalogState(databaseUrl)).toMatchObject({
        rows: [
          {
            captured_provider_revision: "disabled-revision",
            last_accepted_continuation: null,
            status: "paused",
          },
        ],
      });

      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `UPDATE provider_instance
             SET enabled = true, revision = 're-enabled-revision'
             WHERE id = $1`,
            [PROVIDER_INSTANCE_ID],
          ),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* resumeReenabledCatalog() {
          expect(yield* database.catalog.listScanCandidates).toEqual([
            { providerInstanceId: PROVIDER_INSTANCE_ID, revision: "re-enabled-revision" },
          ]);
          expect(
            yield* database.catalog.beginScan({
              coreRunId: RESTARTED_CORE_RUN_ID,
              providerInstanceId: PROVIDER_INSTANCE_ID,
            }),
          ).toMatchObject({ failureCount: 0 });
        }),
      );
    }),
  ),
);

it.live("resolves ambiguous page completion from durable scan and mapping state", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* resolvedCatalogPage() {
      yield* initializeScanDatabase(databaseUrl);
      const item = movieObservation(PROVIDER_INSTANCE_ID);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* resolveCommittedPage() {
          yield* database.catalog.beginScan({
            coreRunId: CORE_RUN_ID,
            providerInstanceId: PROVIDER_INSTANCE_ID,
          });
          yield* database.catalog.acceptPage({
            complete: false,
            coreRunId: CORE_RUN_ID,
            items: [item],
            nextContinuation: NEXT_CONTINUATION,
            providerInstanceId: PROVIDER_INSTANCE_ID,
            revision: CAPTURED_REVISION,
          });
          expect(
            yield* database.catalog.resolvePageAcceptance({
              complete: false,
              coreRunId: CORE_RUN_ID,
              itemReferences: [item.itemReference, item.itemReference],
              nextContinuation: NEXT_CONTINUATION,
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            }),
          ).toBe(true);
          expect(
            yield* database.catalog.resolvePageAcceptance({
              complete: false,
              coreRunId: CORE_RUN_ID,
              itemReferences: [item.itemReference],
              nextContinuation: "different-continuation",
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            }),
          ).toBe(false);
        }),
      );
    }),
  ),
);
