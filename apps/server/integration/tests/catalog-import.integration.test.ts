// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/no-null, unicorn/no-useless-undefined -- These disposable-PostgreSQL scenarios keep exact scan timing, failure, cancellation, and SQL-null evidence visible in execution order.
import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { ProviderItemReferenceSchema } from "@nama/api/nama/plugin/v1/common_pb.js";
import { ListConsistency, ListItemsResponseSchema } from "@nama/api/nama/plugin/v1/library_pb.js";
import { MediaKind, ProviderMediaItemSchema } from "@nama/api/nama/plugin/v1/media_pb.js";
import { Clock, Deferred, Effect } from "effect";

import { makeCatalogImport } from "../../src/catalog/catalog-import.ts";
import type {
  CatalogImportDependencies,
  CatalogImportService,
} from "../../src/catalog/catalog-import.ts";
import { PluginRpcError } from "../../src/plugin/errors.ts";
import { initializeCatalogDatabase, movieObservation } from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const PROVIDER_INSTANCE_ID = "catalog-import-provider";
const CAPTURED_REVISION = `${PROVIDER_INSTANCE_ID}-revision`;
const CORE_RUN_ID = "catalog-import-core-run";
const PROVIDER_DIGEST_BYTES = 32;
const CATALOG_POLL_MILLISECONDS = 25;
const CATALOG_WAIT_MILLISECONDS = 5000;
const ARTWORK_FREE_IMPORT_DEPENDENCIES = {
  loadArtworkAsset: () => Effect.succeed(undefined),
  now: Date.now,
} satisfies Pick<CatalogImportDependencies, "loadArtworkAsset" | "now">;

const pluginItemReference = (itemId: string) => create(ProviderItemReferenceSchema, { itemId });

const hierarchyItem = (kind: "episode" | "season" | "show", itemId: string) => {
  if (kind === "episode") {
    return create(ProviderMediaItemSchema, {
      itemReference: pluginItemReference(itemId),
      kind: MediaKind.EPISODE,
      kindDetails: {
        case: "episode",
        value: {
          episodeNumber: 1,
          seasonNumber: 1,
          seasonReference: pluginItemReference("season"),
          showReference: pluginItemReference("show"),
        },
      },
      runtime: { nanos: 0, seconds: 1800n },
      title: "Episode",
    });
  }
  if (kind === "season") {
    return create(ProviderMediaItemSchema, {
      itemReference: pluginItemReference(itemId),
      kind: MediaKind.SEASON,
      kindDetails: {
        case: "season",
        value: { seasonNumber: 1, showReference: pluginItemReference("show") },
      },
      runtime: { nanos: 0, seconds: 0n },
      title: "Season",
    });
  }
  return create(ProviderMediaItemSchema, {
    itemReference: pluginItemReference(itemId),
    kind: MediaKind.SHOW,
    kindDetails: { case: "show", value: {} },
    runtime: { nanos: 0, seconds: 0n },
    title: "Show",
  });
};

const completePage = (items = [hierarchyItem("show", "show")]) =>
  create(ListItemsResponseSchema, {
    complete: true,
    consistency: ListConsistency.BEST_EFFORT_SCAN,
    items,
  });

const passthroughActivity = <Success, Failure, Requirements>(
  _providerInstanceId: string,
  activity: Effect.Effect<Success, Failure, Requirements>,
) => activity;

const catalogRows = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly item_count: number;
        readonly mapping_count: number;
        readonly status: string;
        readonly title_count: number;
      }>(
        `SELECT
           (SELECT count(*)::integer FROM canonical_item) AS item_count,
           (SELECT count(*)::integer FROM provider_item_mapping) AS mapping_count,
           (SELECT status FROM provider_catalog_scan_state WHERE provider_instance_id = $1) AS status,
           (SELECT count(*)::integer FROM library_entry) AS title_count`,
        [PROVIDER_INSTANCE_ID],
      ),
    ),
  );

const scanFailure = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly consecutive_failure_count: number;
        readonly next_retry_at: Date | null;
        readonly safe_failure_reason: string;
      }>(
        `SELECT consecutive_failure_count, next_retry_at, safe_failure_reason
         FROM provider_catalog_scan_state
         WHERE provider_instance_id = $1`,
        [PROVIDER_INSTANCE_ID],
      ),
    ),
  );

const pollCatalogStatus = (
  databaseUrl: string,
  expectedStatus: string,
  deadline: number,
): Effect.Effect<void> =>
  Effect.gen(function* catalogStatusPoll() {
    const snapshot = yield* catalogRows(databaseUrl);
    if (snapshot.rows[0]?.status === expectedStatus) {
      return yield* Effect.void;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* Effect.die(
        new Error(`catalog scan did not reach ${expectedStatus} before the deadline`),
      );
    }
    yield* Effect.sleep(CATALOG_POLL_MILLISECONDS);
    return yield* pollCatalogStatus(databaseUrl, expectedStatus, deadline);
  });

const waitForCatalogStatus = (databaseUrl: string, expectedStatus: string) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      pollCatalogStatus(databaseUrl, expectedStatus, now + CATALOG_WAIT_MILLISECONDS),
    ),
  );

const pollFailureCount = (
  databaseUrl: string,
  expectedCount: number,
  deadline: number,
): Effect.Effect<void> =>
  Effect.gen(function* catalogFailurePoll() {
    const failure = yield* scanFailure(databaseUrl);
    if (failure.rows[0]?.consecutive_failure_count === expectedCount) {
      return yield* Effect.void;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= deadline) {
      return yield* Effect.die(
        new Error(`catalog scan failure count did not reach ${expectedCount} before the deadline`),
      );
    }
    yield* Effect.sleep(CATALOG_POLL_MILLISECONDS);
    return yield* pollFailureCount(databaseUrl, expectedCount, deadline);
  });

const waitForFailureCount = (databaseUrl: string, expectedCount: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      pollFailureCount(databaseUrl, expectedCount, now + CATALOG_WAIT_MILLISECONDS),
    ),
  );

const startImporter = (importer: CatalogImportService) =>
  importer.start((cause: unknown) => Effect.die(cause));

it.live("imports duplicate out-of-order pages into one published canonical hierarchy", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* initialCatalogImport() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      const requests: string[] = [];
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: CORE_RUN_ID,
          listPage: (_provider, scan) => {
            requests.push(scan.case);
            if (scan.case === "begin") {
              return Effect.succeed(
                create(ListItemsResponseSchema, {
                  complete: false,
                  consistency: ListConsistency.BEST_EFFORT_SCAN,
                  items: [hierarchyItem("episode", "episode"), hierarchyItem("episode", "episode")],
                  nextPageToken: "next-page",
                }),
              );
            }
            return Effect.succeed(
              completePage([hierarchyItem("season", "season"), hierarchyItem("show", "show")]),
            );
          },
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* runInitialCatalogImport() {
            yield* startImporter(importer);
            yield* waitForCatalogStatus(databaseUrl, "succeeded");
          }),
        );
      });

      expect(requests).toEqual(["begin", "continuation"]);
      expect(yield* catalogRows(databaseUrl)).toMatchObject({
        rows: [{ item_count: 3, mapping_count: 3, status: "succeeded", title_count: 3 }],
      });
    }),
  ),
);

it.live("admits only one active scan for a provider across overlapping scheduler passes", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* singleActiveCatalogImport() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let activeCalls = 0;
      let maximumActiveCalls = 0;
      let calls = 0;
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: CORE_RUN_ID,
          listPage: () =>
            Effect.gen(function* blockedCatalogPage() {
              calls += 1;
              activeCalls += 1;
              maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              activeCalls -= 1;
              return completePage();
            }),
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* overlappingScans() {
            yield* startImporter(importer);
            yield* Deferred.await(entered);
            yield* Effect.sleep(1100);
            expect(calls).toBe(1);
            yield* Deferred.succeed(release, undefined);
            yield* waitForCatalogStatus(databaseUrl, "succeeded");
          }),
        );
      });
      expect(maximumActiveCalls).toBe(1);
    }),
  ),
);

it.live(
  "restarts an invalid saved continuation and safely deduplicates repeated provider reads",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* invalidContinuationRecovery() {
        yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
        yield* useDatabase(databaseUrl, productionMigrations, (database) =>
          Effect.gen(function* storeInterruptedScan() {
            yield* database.catalog.beginScan({
              coreRunId: "previous-core-run",
              providerInstanceId: PROVIDER_INSTANCE_ID,
            });
            yield* database.catalog.acceptPage({
              complete: false,
              coreRunId: "previous-core-run",
              items: [movieObservation(PROVIDER_INSTANCE_ID)],
              nextContinuation: "expired-continuation",
              providerInstanceId: PROVIDER_INSTANCE_ID,
              revision: CAPTURED_REVISION,
            });
          }),
        );
        const requests: string[] = [];
        yield* useDatabase(databaseUrl, productionMigrations, (database) => {
          const importer = makeCatalogImport({
            ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
            catalog: database.catalog,
            coreRunId: CORE_RUN_ID,
            listPage: (_provider, scan) => {
              requests.push(scan.case);
              if (scan.case === "continuation") {
                return Effect.fail(new PluginRpcError({ code: Code.InvalidArgument }));
              }
              return Effect.succeed(completePage());
            },
            random: () => 0,
            runProviderActivity: passthroughActivity,
          });
          return Effect.scoped(
            Effect.gen(function* resumeCatalogImport() {
              yield* startImporter(importer);
              yield* waitForCatalogStatus(databaseUrl, "succeeded");
            }),
          );
        });

        expect(requests).toEqual(["continuation", "begin"]);
        expect(yield* catalogRows(databaseUrl)).toMatchObject({
          rows: [{ item_count: 2, mapping_count: 2, status: "succeeded" }],
        });
      }),
    ),
);

it.live("persists RetryInfo-bounded backoff and permanent safe failure classes", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* classifiedCatalogFailures() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      const beforeRetry = Date.now();
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: CORE_RUN_ID,
          listPage: () =>
            Effect.fail(
              new PluginRpcError({
                code: Code.ResourceExhausted,
                retryAfterMilliseconds: 8000,
              }),
            ),
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* recordRetryableFailure() {
            yield* startImporter(importer);
            yield* waitForFailureCount(databaseUrl, 1);
          }),
        );
      });
      const retry = yield* scanFailure(databaseUrl);
      expect(retry.rows[0]).toMatchObject({
        consecutive_failure_count: 1,
        safe_failure_reason: "plugin_unavailable",
      });
      expect(retry.rows[0]?.next_retry_at?.getTime()).toBeGreaterThanOrEqual(beforeRetry + 8000);

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
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: "permanent-failure-core-run",
          listPage: () => Effect.fail(new PluginRpcError({ code: Code.PermissionDenied })),
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* recordPermanentFailure() {
            yield* startImporter(importer);
            yield* waitForFailureCount(databaseUrl, 2);
          }),
        );
      });
      expect(yield* scanFailure(databaseUrl)).toMatchObject({
        rows: [
          {
            consecutive_failure_count: 2,
            next_retry_at: null,
            safe_failure_reason: "authentication_failed",
          },
        ],
      });
    }),
  ),
);
it.live("resets the running scan backoff after an accepted page", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* resetCatalogBackoff() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: CORE_RUN_ID,
          listPage: () => Effect.fail(new PluginRpcError({ code: Code.Unavailable })),
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* recordInitialFailure() {
            yield* startImporter(importer);
            yield* waitForFailureCount(databaseUrl, 1);
          }),
        );
      });
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `UPDATE provider_catalog_scan_state
             SET consecutive_failure_count = 5,
                 last_accepted_continuation = 'resume-page',
                 next_retry_at = transaction_timestamp() - interval '1 second'
             WHERE provider_instance_id = $1`,
            [PROVIDER_INSTANCE_ID],
          ),
        ),
      );

      const requests: string[] = [];
      const beforeRetry = Date.now();
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: "resumed-core-run",
          listPage: (_provider, scan) => {
            requests.push(scan.case);
            if (requests.length === 1) {
              return Effect.succeed(
                create(ListItemsResponseSchema, {
                  complete: false,
                  consistency: ListConsistency.BEST_EFFORT_SCAN,
                  items: [hierarchyItem("show", "show")],
                  nextPageToken: "next-page",
                }),
              );
            }
            return Effect.fail(new PluginRpcError({ code: Code.Unavailable }));
          },
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* resumeFailedCatalogImport() {
            yield* startImporter(importer);
            yield* waitForFailureCount(databaseUrl, 1);
          }),
        );
      });

      const failure = yield* scanFailure(databaseUrl);
      expect(requests).toEqual(["continuation", "continuation"]);
      expect(failure.rows[0]).toMatchObject({
        consecutive_failure_count: 1,
        safe_failure_reason: "provider_unavailable",
      });
      expect(failure.rows[0]?.next_retry_at?.getTime()).toBeGreaterThanOrEqual(beforeRetry + 5000);
      expect(failure.rows[0]?.next_retry_at?.getTime()).toBeLessThan(beforeRetry + 20_000);
    }),
  ),
);

it.live("discovers provider instances created after importer construction", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* newlyEligibleCatalogImport() {
      yield* initializeCatalogDatabase(databaseUrl, []);
      let calls = 0;
      const firstPoll = yield* Deferred.make<void>();
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: {
            ...database.catalog,
            listScanCandidates: database.catalog.listScanCandidates.pipe(
              Effect.tap(() => Deferred.succeed(firstPoll, undefined)),
            ),
          },
          coreRunId: CORE_RUN_ID,
          listPage: () => {
            calls += 1;
            return Effect.succeed(completePage());
          },
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.scoped(
          Effect.gen(function* laterProviderScan() {
            yield* startImporter(importer);
            yield* Deferred.await(firstPoll);
            expect(calls).toBe(0);
            yield* withPool(databaseUrl, (pool) =>
              Effect.promise(() =>
                pool.query(
                  `INSERT INTO provider_instance (
                     configuration, display_name, enabled, id, principal_digest,
                     provider_type_id, revision, sync_priority
                   ) VALUES ('{}'::jsonb, 'Later provider', true, $1, $2,
                             'catalog-test-provider', $3, 1)`,
                  [PROVIDER_INSTANCE_ID, Buffer.alloc(PROVIDER_DIGEST_BYTES, 1), CAPTURED_REVISION],
                ),
              ),
            );
            yield* waitForCatalogStatus(databaseUrl, "succeeded");
          }),
        );
      });
      expect(calls).toBe(1);
    }),
  ),
);

it.live("propagates catalog scan interruption without persisting a false failure", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* canceledCatalogImport() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      const entered = yield* Deferred.make<void>();
      const canceled = yield* Deferred.make<void>();
      yield* useDatabase(databaseUrl, productionMigrations, (database) => {
        const importer = makeCatalogImport({
          ...ARTWORK_FREE_IMPORT_DEPENDENCIES,
          catalog: database.catalog,
          coreRunId: CORE_RUN_ID,
          listPage: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(canceled, undefined)),
            ),
          random: () => 0,
          runProviderActivity: passthroughActivity,
        });
        return Effect.gen(function* interruptCatalogScan() {
          yield* Effect.scoped(
            Effect.gen(function* runInterruptedCatalogScan() {
              yield* startImporter(importer);
              yield* Deferred.await(entered);
            }),
          );
          yield* Deferred.await(canceled);
        });
      });
      expect(yield* scanFailure(databaseUrl)).toMatchObject({
        rows: [
          {
            consecutive_failure_count: 0,
            next_retry_at: null,
            safe_failure_reason: null,
          },
        ],
      });
    }),
  ),
);
