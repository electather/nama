import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import type {
  CatalogItemObservation,
  StoredCatalogItem,
} from "../../src/database/catalog-persistence-model-private.ts";
import {
  applyMigrationFolder,
  listProductionMigrationTags,
  makeCurrentProviderMigrationFolder,
} from "./catalog-migration.test-support.ts";
import {
  ADMINISTRATOR_ID,
  EXTERNAL_IDENTIFIER_SENTINEL,
  PROVIDER_PAYLOAD_SENTINEL,
  audioSource,
  episodeObservation,
  initializeCatalogDatabase,
  movieObservation,
  retargetProviderMapping,
  seasonObservation,
  showObservation,
  videoSource,
} from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const FIRST_INDEX = 0;
const CONCURRENT_OBSERVATIONS = 12;
const EXPECTED_CATALOG_MIGRATION_COUNT = 4;
const EXPECTED_PAIR_COUNT = 2;
const EXPECTED_SINGLE_ID_COUNT = 1;
const CATALOG_TABLES = [
  "canonical_artwork",
  "canonical_credit",
  "canonical_hierarchy",
  "canonical_item",
  "library_entry",
  "media_part",
  "media_source",
  "media_track",
  "provider_artwork_mapping",
  "provider_catalog_scan_state",
  "provider_external_identifier",
  "provider_item_mapping",
  "provider_item_parent_reference",
  "provider_part_mapping",
  "provider_source_mapping",
  "provider_track_mapping",
].toSorted();

interface AggregateIdentitySnapshot {
  readonly artworkId: string | undefined;
  readonly createdAt: Date | undefined;
  readonly itemId: string;
  readonly partId: string | undefined;
  readonly sourceId: string | undefined;
  readonly trackId: string | undefined;
}

const aggregateIdentitySnapshot = (item: StoredCatalogItem): AggregateIdentitySnapshot => {
  const primarySource = item.sources.find((source) => source.label === "Primary");
  const artwork = item.artwork[FIRST_INDEX];
  const part = primarySource?.parts[FIRST_INDEX];
  const track = part?.tracks[FIRST_INDEX];
  expect(primarySource).toBeDefined();
  expect(artwork).toBeDefined();
  expect(part).toBeDefined();
  expect(track).toBeDefined();
  expect(item.libraryCreatedAt).toBeDefined();
  return {
    artworkId: artwork?.id,
    createdAt: item.libraryCreatedAt,
    itemId: item.id,
    partId: part?.id,
    sourceId: primarySource?.id,
    trackId: track?.id,
  };
};

const replacementObservation = (): CatalogItemObservation =>
  movieObservation("provider-refresh", {
    artwork: [],
    contentRating: undefined,
    credits: [],
    externalIdentifiers: [],
    genres: [],
    originalTitle: undefined,
    releaseDate: undefined,
    releaseYear: undefined,
    runtime: { nanoseconds: 0, seconds: 0n },
    sources: [audioSource()],
    studios: [],
    synopsis: undefined,
    tagline: undefined,
    title: "Replacement without optional metadata",
  });

const assertClearedAggregate = (
  item: StoredCatalogItem,
  identity: AggregateIdentitySnapshot,
): void => {
  expect(item.id).toBe(identity.itemId);
  expect(item).toMatchObject({
    artwork: [],
    contentRating: undefined,
    credits: [],
    genres: [],
    originalTitle: undefined,
    releaseDate: undefined,
    releaseYear: undefined,
    studios: [],
    synopsis: undefined,
    tagline: undefined,
    title: "Replacement without optional metadata",
  });
  expect(item.sources.map((source) => source.label)).toEqual(["Commentary"]);
  expect(item.libraryCreatedAt?.getTime()).toBe(identity.createdAt?.getTime());
};

const canonicalReadJson = (item: StoredCatalogItem): string =>
  JSON.stringify(item, (_key, value: unknown) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  });

const assertRestoredAggregate = (
  item: StoredCatalogItem,
  identity: AggregateIdentitySnapshot,
): void => {
  const primarySource = item.sources.find((source) => source.label === "Primary");
  expect(item.id).toBe(identity.itemId);
  expect(item.artwork[FIRST_INDEX]?.id).toBe(identity.artworkId);
  expect(primarySource?.id).toBe(identity.sourceId);
  expect(primarySource?.parts[FIRST_INDEX]?.id).toBe(identity.partId);
  expect(primarySource?.parts[FIRST_INDEX]?.tracks[FIRST_INDEX]?.id).toBe(identity.trackId);
  expect(item.libraryCreatedAt?.getTime()).toBe(identity.createdAt?.getTime());
  expect(canonicalReadJson(item)).not.toContain(PROVIDER_PAYLOAD_SENTINEL);
};

const loadExternalIdentifierEvidence = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly namespace: string;
        readonly value: string;
      }>(
        "SELECT namespace, value FROM provider_external_identifier WHERE provider_instance_id = $1",
        ["provider-refresh"],
      ),
    ),
  );

const loadRetainedMappingCounts = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly artwork_count: number;
        readonly part_count: number;
        readonly source_count: number;
        readonly track_count: number;
      }>(`SELECT
            (SELECT count(*)::integer FROM provider_artwork_mapping) AS artwork_count,
            (SELECT count(*)::integer FROM provider_part_mapping) AS part_count,
            (SELECT count(*)::integer FROM provider_source_mapping) AS source_count,
            (SELECT count(*)::integer FROM provider_track_mapping) AS track_count`),
    ),
  );

const verifyCatalogEvidence = (databaseUrl: string) =>
  Effect.gen(function* catalogEvidenceAssertions() {
    const evidence = yield* loadExternalIdentifierEvidence(databaseUrl);
    expect(evidence.rows).toEqual([{ namespace: "imdb", value: EXTERNAL_IDENTIFIER_SENTINEL }]);
    const retainedMappings = yield* loadRetainedMappingCounts(databaseUrl);
    expect(retainedMappings.rows[FIRST_INDEX]).toEqual({
      artwork_count: 2,
      part_count: 2,
      source_count: 2,
      track_count: 2,
    });
  });

const assertUnresolvedHierarchy = (records: {
  readonly episode: StoredCatalogItem;
  readonly season: StoredCatalogItem;
}): void => {
  expect(records.episode.libraryCreatedAt).toBeUndefined();
  expect(records.episode.parents).toEqual([]);
  expect(records.season.libraryCreatedAt).toBeUndefined();
  expect(records.season.parents).toEqual([]);
};

const assertPublishedHierarchy = (records: {
  readonly episode: StoredCatalogItem | undefined;
  readonly season: StoredCatalogItem | undefined;
  readonly show: StoredCatalogItem;
}): void => {
  expect(records.show.libraryCreatedAt).toBeDefined();
  expect(records.season?.libraryCreatedAt).toBeDefined();
  expect(records.episode?.libraryCreatedAt).toBeDefined();
  expect(records.season?.parents.map((parent) => parent.relationship)).toEqual(["show"]);
  expect(records.episode?.parents.map((parent) => parent.relationship).toSorted()).toEqual([
    "season",
    "show",
  ]);
};

const loadLibraryTitles = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{ readonly title: string }>(`SELECT item.title
        FROM library_entry AS entry
        INNER JOIN canonical_item AS item ON item.id = entry.canonical_item_id
        ORDER BY item.title`),
    ),
  );

interface DeletionFixtures {
  readonly orphan: StoredCatalogItem;
  readonly sharedA: StoredCatalogItem;
  readonly sharedB: StoredCatalogItem;
}

const observeDeletionFixtures = (databaseUrl: string) =>
  useDatabase(databaseUrl, productionMigrations, (database) =>
    Effect.gen(function* observeProviderDeletionFixtures() {
      const sharedA = yield* database.catalog.observeItem(
        movieObservation("provider-shared-a", { itemReference: "shared-a-item" }),
      );
      const sharedB = yield* database.catalog.observeItem(
        movieObservation("provider-shared-b", { itemReference: "shared-b-item" }),
      );
      const orphan = yield* database.catalog.observeItem(
        movieObservation("provider-orphan", { itemReference: "orphan-item" }),
      );
      return { orphan, sharedA, sharedB };
    }),
  );

const prepareFutureSharedMapping = (databaseUrl: string, observed: DeletionFixtures) =>
  withPool(databaseUrl, (pool) =>
    Effect.gen(function* prepareSharedCatalogDeletion() {
      yield* retargetProviderMapping(pool, "provider-shared-b", observed.sharedA.id);
      yield* Effect.promise(() =>
        pool.query("DELETE FROM library_entry WHERE canonical_item_id = $1", [observed.sharedB.id]),
      );
      yield* Effect.promise(() =>
        pool.query("UPDATE provider_instance SET enabled = FALSE WHERE id = ANY($1::text[])", [
          ["provider-shared-b", "provider-orphan"],
        ]),
      );
    }),
  );

const deleteProvider = (databaseUrl: string, providerInstanceId: string) =>
  useDatabase(databaseUrl, productionMigrations, (database) =>
    database.providers.deleteInstance({
      expectedRevision: `${providerInstanceId}-revision`,
      operation: {
        administratorUserId: ADMINISTRATOR_ID,
        canonicalRequest: new TextEncoder().encode(providerInstanceId),
        method: "nama.api.v1.ProviderService.DeleteProviderInstance",
        operationId: `${providerInstanceId}-delete`,
        serializedResult: {},
      },
      providerInstanceId,
    }),
  );

const loadCatalogRetentionCounts = (databaseUrl: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query<{
        readonly canonical_count: number;
        readonly library_count: number;
        readonly mapping_count: number;
        readonly source_count: number;
      }>(`SELECT
            (SELECT count(*)::integer FROM canonical_item) AS canonical_count,
            (SELECT count(*)::integer FROM library_entry) AS library_count,
            (SELECT count(*)::integer FROM provider_item_mapping) AS mapping_count,
            (SELECT count(*)::integer FROM media_source) AS source_count`),
    ),
  );

const invalidRollbackObservation = (): CatalogItemObservation => {
  const source = videoSource();
  const retainedPart = source.parts[FIRST_INDEX];
  if (retainedPart === undefined) {
    throw new Error("rollback fixture has no media part");
  }
  return movieObservation("provider-rollback", {
    sources: [
      {
        ...source,
        parts: [
          ...source.parts,
          {
            ...retainedPart,
            partReference: "different-part-same-order",
          },
        ],
      },
    ],
    title: "Must roll back",
  });
};

const collectConstraintFailures = (databaseUrl: string, canonicalItemId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(async () => {
      const failures: unknown[] = [];
      try {
        await pool.query(
          "INSERT INTO canonical_item (id, kind, title, runtime_seconds, runtime_nanoseconds, genres, studios) VALUES ($1, 'movie', 'Invalid', 0, 0, '{}', '{}')",
          ["not-an-opaque-uuid"],
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await pool.query(
          "INSERT INTO canonical_hierarchy (child_item_id, child_kind, relationship, parent_item_id, parent_kind) VALUES ($1, 'movie', 'show', $1, 'movie')",
          [canonicalItemId],
        );
      } catch (error) {
        failures.push(error);
      }
      return failures;
    }),
  );

it.live("migrates a fresh database and the current provider journal to the catalog model", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* catalogMigrationUpgrade() {
      const priorTags = yield* makeCurrentProviderMigrationFolder().pipe(
        Effect.flatMap((migrationFolder) =>
          Effect.gen(function* applyProviderJournal() {
            yield* applyMigrationFolder(databaseUrl, migrationFolder);
            return yield* listProductionMigrationTags();
          }),
        ),
      );
      expect(priorTags.length).toBeGreaterThanOrEqual(EXPECTED_CATALOG_MIGRATION_COUNT);

      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const tables = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query<{ readonly table_name: string }>(
            `SELECT table_name
             FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = ANY($1::text[])
             ORDER BY table_name`,
            [CATALOG_TABLES],
          ),
        ),
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(CATALOG_TABLES);
    }),
  ),
);

it.live("reuses one opaque canonical item for concurrent exact observations", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* concurrentExactMapping() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: "provider-concurrent", priority: 1 }]);
      const records = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.all(
          Array.from({ length: CONCURRENT_OBSERVATIONS }, () =>
            database.catalog.observeItem(movieObservation("provider-concurrent")),
          ),
          { concurrency: "unbounded" },
        ),
      );
      const ids = new Set(records.map((record) => record.id));
      expect(ids.size).toBe(EXPECTED_SINGLE_ID_COUNT);
      expect(records[FIRST_INDEX]?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );

      const counts = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query<{
            readonly canonical_count: number;
            readonly mapping_count: number;
          }>(`SELECT
                (SELECT count(*)::integer FROM canonical_item) AS canonical_count,
                (SELECT count(*)::integer FROM provider_item_mapping) AS mapping_count`),
        ),
      );
      expect(counts.rows[FIRST_INDEX]).toEqual({ canonical_count: 1, mapping_count: 1 });
    }),
  ),
);

it.live("atomically replaces aggregates while retaining inactive nested identities", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* completeAggregateReplacement() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: "provider-refresh", priority: 1 }]);
      const first = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(movieObservation("provider-refresh")),
      );
      const identity = aggregateIdentitySnapshot(first);
      const middle = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(replacementObservation()),
      );
      assertClearedAggregate(middle, identity);
      const restored = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(
          movieObservation("provider-refresh", { title: "Restored aggregate" }),
        ),
      );
      assertRestoredAggregate(restored, identity);
      yield* verifyCatalogEvidence(databaseUrl);
    }),
  ),
);

it.live("preserves the Library entry while every source is temporarily omitted", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* sourceFreeRefresh() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: "provider-refresh", priority: 1 }]);
      const first = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(movieObservation("provider-refresh")),
      );
      const libraryCreatedAt = first.libraryCreatedAt?.getTime();
      expect(libraryCreatedAt).toBeDefined();

      const omitted = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(movieObservation("provider-refresh", { sources: [] })),
      );
      expect(omitted.sources).toEqual([]);
      expect(omitted.libraryCreatedAt?.getTime()).toBe(libraryCreatedAt);

      const restored = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(movieObservation("provider-refresh")),
      );
      expect(restored.libraryCreatedAt?.getTime()).toBe(libraryCreatedAt);
    }),
  ),
);

it.live("publishes unresolved seasons and episodes only after kind-correct hierarchy repair", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* unresolvedHierarchyRepair() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: "provider-hierarchy", priority: 1 }]);
      const unresolved = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* observeChildrenFirst() {
          const episode = yield* database.catalog.observeItem(
            episodeObservation("provider-hierarchy"),
          );
          const season = yield* database.catalog.observeItem(
            seasonObservation("provider-hierarchy"),
          );
          return { episode, season };
        }),
      );
      assertUnresolvedHierarchy(unresolved);
      const repaired = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* observeRequiredParent() {
          const show = yield* database.catalog.observeItem(showObservation("provider-hierarchy"));
          const season = yield* database.catalog.loadItem(unresolved.season.id);
          const episode = yield* database.catalog.loadItem(unresolved.episode.id);
          return { episode, season, show };
        }),
      );
      assertPublishedHierarchy(repaired);
      const publicTitles = yield* loadLibraryTitles(databaseUrl);
      expect(publicTitles.rows.map((row) => row.title)).toEqual([
        "Catalog Show",
        "Episode Two",
        "Season One",
      ]);
    }),
  ),
);

it.live("publishes concurrently observed kind-correct hierarchy", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* concurrentHierarchyRepair() {
      yield* initializeCatalogDatabase(databaseUrl, [
        { id: "provider-concurrent-hierarchy", priority: 1 },
      ]);
      const stored = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* observeHierarchyConcurrently() {
          const [show, season, episode] = yield* Effect.all(
            [
              database.catalog.observeItem(showObservation("provider-concurrent-hierarchy")),
              database.catalog.observeItem(seasonObservation("provider-concurrent-hierarchy")),
              database.catalog.observeItem(episodeObservation("provider-concurrent-hierarchy")),
            ],
            { concurrency: "unbounded" },
          );
          return {
            episode: yield* database.catalog.loadItem(episode.id),
            season: yield* database.catalog.loadItem(season.id),
            show,
          };
        }),
      );

      expect(stored.show.libraryCreatedAt).toBeDefined();
      expect(stored.season?.libraryCreatedAt).toBeDefined();
      expect(stored.episode?.libraryCreatedAt).toBeDefined();
      expect(stored.season?.parents.map((parent) => parent.relationship)).toEqual(["show"]);
      expect(stored.episode?.parents.map((parent) => parent.relationship).toSorted()).toEqual([
        "season",
        "show",
      ]);
    }),
  ),
);

it.live(
  "removes provider-owned catalog rows without deleting shared or orphaned canonical items",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* fencedProviderCatalogDeletion() {
        yield* initializeCatalogDatabase(
          databaseUrl,
          [
            { id: "provider-shared-a", priority: 1 },
            { id: "provider-shared-b", priority: 2 },
            { id: "provider-orphan", priority: 3 },
          ],
          true,
        );
        const observed = yield* observeDeletionFixtures(databaseUrl);
        yield* prepareFutureSharedMapping(databaseUrl, observed);
        expect(yield* deleteProvider(databaseUrl, "provider-shared-b")).toBe(true);
        expect(yield* deleteProvider(databaseUrl, "provider-orphan")).toBe(true);
        const retained = yield* loadCatalogRetentionCounts(databaseUrl);
        expect(retained.rows[FIRST_INDEX]).toEqual({
          canonical_count: 3,
          library_count: 1,
          mapping_count: 1,
          source_count: 2,
        });
      }),
    ),
);

it.live("rolls back a rejected aggregate and enforces catalog ownership constraints", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* aggregateRollback() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: "provider-rollback", priority: 1 }]);
      const initial = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(movieObservation("provider-rollback")),
      );
      const failed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.exit(database.catalog.observeItem(invalidRollbackObservation())),
      );
      expect(Exit.isFailure(failed)).toBe(true);
      const afterFailure = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.loadItem(initial.id),
      );
      expect(afterFailure?.title).toBe("Catalog Movie");
      expect(afterFailure?.sources).toHaveLength(EXPECTED_PAIR_COUNT);
      const constraintFailures = yield* collectConstraintFailures(databaseUrl, initial.id);
      expect(constraintFailures).toHaveLength(EXPECTED_PAIR_COUNT);
    }),
  ),
);
