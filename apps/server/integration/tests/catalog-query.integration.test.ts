// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary, import/max-dependencies -- Disposable PostgreSQL catalog-query acceptance keeps each stateful setup and assertion sequence visible.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { ErrorInfoSchema, RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { Effect } from "effect";

import {
  GetHomeRequestSchema,
  GetMediaRequestSchema,
  GetMediaSourceRequestSchema,
  HomeSectionKind,
  LibraryService,
  LibrarySort,
  ListLibraryRequestSchema,
  ListChildrenRequestSchema,
  ResolveArtworkRequestSchema,
  SearchRequestSchema,
  WatchFilter,
} from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import {
  MediaKind,
  Playability,
  SourceAvailability,
} from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type { AuthenticationService } from "../../src/authentication/authentication-service.ts";
import type { ArtworkAccessService } from "../../src/catalog/catalog-artwork-access.ts";
import { CatalogQuery } from "../../src/catalog/catalog-query-live.ts";
import { makeCatalogQuery } from "../../src/catalog/catalog-query.ts";
import type { Database } from "../../src/database/database.ts";
import { startServer } from "../../src/http/tests/http-server.test-support.ts";
import {
  episodeObservation,
  ADMINISTRATOR_ID,
  initializeCatalogDatabase,
  movieObservation,
  seasonObservation,
  showObservation,
  videoSource,
  retargetProviderMapping,
} from "./catalog-persistence.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const PROVIDER_INSTANCE_ID = "catalog-query-provider";
const FIRST_ROW_INDEX = 0;
const MASTER_KEY = `base64:${Buffer.alloc(32, 41).toString("base64")}`;
const PRINCIPAL_ID = "catalog-reader";
const NOW = new Date("2026-08-25T12:00:00.000Z").getTime();
const LIBRARY_BEARER = "Bearer catalog-reader";
const OTHER_LIBRARY_BEARER = "Bearer another-catalog-reader";
const requestOptions = { headers: { authorization: LIBRARY_BEARER } } as const;
const otherRequestOptions = { headers: { authorization: OTHER_LIBRARY_BEARER } } as const;

const authentication: AuthenticationService = Object.freeze({
  approveDeviceAuthorization: () => Effect.die("unexpected device authorization approval"),
  consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
  consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
  resolveAdministrator: () => Effect.die("unexpected administrator resolution"),
  resolveConsumerPrincipal: (authorization: string) => {
    if (authorization === OTHER_LIBRARY_BEARER) {
      return Effect.succeed({ id: "another-principal" });
    }
    return Effect.succeed({ id: PRINCIPAL_ID });
  },
  resolvePrincipal: () => Effect.die("unexpected principal resolution"),
  revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
  signIn: () => Effect.die("unexpected sign-in"),
  signOut: () => Effect.die("unexpected sign-out"),
});

const startCatalogClient = (database: Database["Service"], catalogQuery: CatalogQuery["Service"]) =>
  Effect.gen(function* startStoredCatalogClient() {
    const server = yield* startServer(database, {
      authentication,
      catalogQuery: CatalogQuery.of(catalogQuery),
    });
    return createClient(
      LibraryService,
      createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
    );
  });

const captureConnectFailure = (invoke: () => Promise<unknown>) =>
  Effect.tryPromise({ catch: (error) => error, try: invoke }).pipe(
    Effect.flip,
    Effect.map((failure) => {
      if (!(failure instanceof ConnectError)) {
        throw new TypeError("expected a Connect application failure");
      }
      return failure;
    }),
  );

const markProviderHealthy = (databaseUrl: string, providerInstanceId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query(
        `INSERT INTO provider_instance_observation (
           instance_revision, provider_instance_id, status, summary
         ) VALUES ($1, $2, 'healthy', 'healthy')
         ON CONFLICT (provider_instance_id) DO UPDATE
         SET instance_revision = excluded.instance_revision,
             status = excluded.status,
             summary = excluded.summary`,
        [`${providerInstanceId}-revision`, providerInstanceId],
      ),
    ),
  );

const markProviderUnavailable = (databaseUrl: string, providerInstanceId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query(
        `UPDATE provider_instance_observation
         SET status = 'unavailable', summary = 'unavailable'
         WHERE provider_instance_id = $1`,
        [providerInstanceId],
      ),
    ),
  );

const markCatalogComplete = (databaseUrl: string, providerInstanceId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query(
        `INSERT INTO provider_catalog_scan_state (
           captured_provider_revision, completed_at, core_run_id, provider_instance_id,
           started_at, status, updated_at
         ) VALUES ($1, transaction_timestamp(), 'completed-run', $2,
           transaction_timestamp(), 'succeeded', transaction_timestamp())`,
        [`${providerInstanceId}-revision`, providerInstanceId],
      ),
    ),
  );

const unexpectedArtworkAccess: ArtworkAccessService = {
  locator: () => {
    throw new Error("unexpected artwork locator");
  },
  read: () => Effect.die("unexpected artwork read"),
};

const makeStoredQuery = (
  database: Database["Service"],
  now: () => number = () => NOW,
  artworkAccess: ArtworkAccessService = unexpectedArtworkAccess,
) =>
  makeCatalogQuery({
    artworkAccess,
    catalog: database.catalogQueries,
    masterKey: MASTER_KEY,
    now,
  });

it.live("stores and replaces the weighted simple full-text projection", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedSearchProjection() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(
          movieObservation(PROVIDER_INSTANCE_ID, {
            credits: [{ name: "Cast Match", role: "actor" }],
            genres: ["Genre Match"],
            originalTitle: "Original Match",
            title: "Title Match",
          }),
        ),
      );

      const initial = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query<{
            readonly castRank: number;
            readonly genreRank: number;
            readonly originalRank: number;
            readonly titleRank: number;
          }>(`SELECT
              ts_rank(search_vector, to_tsquery('simple', 'cast:*')) AS "castRank",
              ts_rank(search_vector, to_tsquery('simple', 'genre:*')) AS "genreRank",
              ts_rank(search_vector, to_tsquery('simple', 'original:*')) AS "originalRank",
              ts_rank(search_vector, to_tsquery('simple', 'title:*')) AS "titleRank"
            FROM canonical_item`),
        ),
      );
      const ranks = initial.rows[FIRST_ROW_INDEX];
      expect(ranks).toBeDefined();
      expect(ranks?.titleRank).toBeGreaterThan(ranks?.originalRank ?? Number.POSITIVE_INFINITY);
      expect(ranks?.originalRank).toBeGreaterThan(ranks?.castRank ?? Number.POSITIVE_INFINITY);
      expect(ranks?.castRank).toBeGreaterThan(ranks?.genreRank ?? Number.POSITIVE_INFINITY);

      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(
          movieObservation(PROVIDER_INSTANCE_ID, {
            credits: [{ name: "Replacement Actor", role: "actor" }],
            genres: ["Replacement Genre"],
            originalTitle: "Replacement Original",
            title: "Replacement Title",
          }),
        ),
      );
      const replacement = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query<{
            readonly oldCastPresent: boolean;
            readonly replacementPresent: boolean;
          }>(`SELECT
              search_vector @@ to_tsquery('simple', 'cast:*') AS "oldCastPresent",
              search_vector @@ to_tsquery('simple', 'replacement:*') AS "replacementPresent"
            FROM canonical_item`),
        ),
      );
      expect(replacement.rows[FIRST_ROW_INDEX]).toEqual({
        oldCastPresent: false,
        replacementPresent: true,
      });
    }),
  ),
);

it.live("returns stored Movies and Shows with effective playability and default sources", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedHome() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* markProviderHealthy(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* markCatalogComplete(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryStoredHome() {
          const unavailableSource = {
            ...videoSource(
              "private-unavailable-source",
              "private-unavailable-part",
              "private-unavailable-track",
            ),
            availability: "provider_unavailable" as const,
          };
          const availableSource = videoSource(
            "private-available-source",
            "private-available-part",
            "private-available-track",
          );
          const movie = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              itemReference: "private-home-movie",
              sources: [unavailableSource, availableSource],
              title: "Home Movie",
            }),
          );
          const show = yield* database.catalog.observeItem(showObservation(PROVIDER_INSTANCE_ID));
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const response = yield* Effect.promise(() =>
            client.getHome({ sectionSize: 20 }, requestOptions),
          );

          expect(response.sections.map(({ id, kind, title }) => ({ id, kind, title }))).toEqual([
            { id: "movies", kind: HomeSectionKind.MOVIES, title: "Movies" },
            { id: "shows", kind: HomeSectionKind.SHOWS, title: "Shows" },
          ]);
          expect(response.sections[0]?.items).toHaveLength(1);
          expect(response.sections[0]?.items[0]).toMatchObject({
            id: movie.id,
            kind: 1,
            playability: Playability.PLAYABLE,
            title: "Home Movie",
          });
          expect(response.sections[0]?.items[0]?.defaultSource).toMatchObject({
            availability: SourceAvailability.AVAILABLE,
            id: movie.sources[1]?.id,
            isDefault: true,
          });
          expect(response.sections[1]?.items[0]).toMatchObject({
            id: show.id,
            title: "Catalog Show",
          });

          const publicJson = JSON.stringify(response, (_key, value: unknown) =>
            typeof value === "bigint" ? value.toString() : value,
          );
          expect(publicJson).not.toContain("private-home-movie");
          expect(publicJson).not.toContain("private-available-source");
          expect(publicJson).not.toContain("catalog-query-provider");

          yield* markProviderUnavailable(databaseUrl, PROVIDER_INSTANCE_ID);
          const outage = yield* Effect.promise(() => client.getHome({}, requestOptions));
          expect(outage.sections[0]?.items[0]).toMatchObject({
            id: movie.id,
            playability: Playability.TEMPORARILY_UNAVAILABLE,
          });
          expect(outage.sections[0]?.items[0]?.defaultSource).toMatchObject({
            availability: SourceAvailability.PROVIDER_UNAVAILABLE,
            id: movie.sources[0]?.id,
          });
          const unavailableSourceId = movie.sources[FIRST_ROW_INDEX]?.id;
          if (unavailableSourceId === undefined) {
            throw new Error("unavailable source fixture is missing");
          }
          const sourceFailure = yield* captureConnectFailure(() =>
            client.getMediaSource(
              { mediaId: movie.id, sourceId: unavailableSourceId },
              requestOptions,
            ),
          );
          expect(sourceFailure.code).toBe(Code.Unavailable);
          expect(sourceFailure.findDetails(ErrorInfoSchema)[FIRST_ROW_INDEX]?.reason).toBe(
            "SOURCE_UNAVAILABLE",
          );
          expect(
            sourceFailure.findDetails(RetryInfoSchema)[FIRST_ROW_INDEX]?.retryDelay,
          ).toMatchObject({
            nanos: 0,
            seconds: 5n,
          });
        }),
      );
    }),
  ),
);

it.live("filters and keyset-paginates stored Library entries with bound expiring tokens", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedLibraryPagination() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* markProviderHealthy(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* markCatalogComplete(databaseUrl, PROVIDER_INSTANCE_ID);
      let currentTime = NOW;
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryStoredLibrary() {
          yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              genres: ["Drama"],
              itemReference: "private-list-bravo",
              releaseDate: "2024-01-02",
              releaseYear: 2024,
              sources: [
                videoSource("private-list-source-b", "private-list-part-b", "private-list-track-b"),
              ],
              title: "Bravo",
            }),
          );
          yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              genres: ["Drama", "Mystery"],
              itemReference: "private-list-alpha",
              releaseDate: "2025-01-02",
              releaseYear: 2025,
              sources: [
                videoSource("private-list-source-a", "private-list-part-a", "private-list-track-a"),
              ],
              title: "alpha",
            }),
          );
          yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              genres: ["Comedy"],
              itemReference: "private-list-charlie",
              releaseDate: undefined,
              releaseYear: undefined,
              sources: [
                {
                  ...videoSource(
                    "private-list-source-c",
                    "private-list-part-c",
                    "private-list-track-c",
                  ),
                  availability: "unsupported",
                },
              ],
              title: "Charlie",
            }),
          );
          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query(
                `UPDATE library_entry
                 SET created_at = CASE canonical_item.title
                   WHEN 'alpha' THEN TIMESTAMPTZ '2026-08-25 12:00:00.123789+00'
                   WHEN 'Bravo' THEN TIMESTAMPTZ '2026-08-25 12:00:00.123456+00'
                   ELSE TIMESTAMPTZ '2026-08-25 12:00:00.123123+00'
                 END
                 FROM canonical_item
                 WHERE canonical_item.id = library_entry.canonical_item_id`,
              ),
            ),
          );
          const query = yield* makeStoredQuery(database, () => currentTime);
          const client = yield* startCatalogClient(database, query);
          const firstPageRequest = create(ListLibraryRequestSchema, {
            filter: { watchFilter: WatchFilter.ANY },
            pageSize: 1,
            sort: LibrarySort.TITLE_ASC,
          });
          const firstPage = yield* Effect.promise(() =>
            client.listLibrary(firstPageRequest, requestOptions),
          );
          expect(firstPage.items.map(({ title }) => title)).toEqual(["alpha"]);
          expect(firstPage.nextPageToken).not.toBe("");
          expect(firstPage.nextPageToken).not.toContain("private-list");

          const secondPage = yield* Effect.promise(() =>
            client.listLibrary(
              { ...firstPageRequest, pageToken: firstPage.nextPageToken },
              requestOptions,
            ),
          );
          expect(secondPage.items.map(({ title }) => title)).toEqual(["Bravo"]);
          const dateAddedRequest = create(ListLibraryRequestSchema, {
            filter: { watchFilter: WatchFilter.ANY },
            pageSize: 1,
            sort: LibrarySort.DATE_ADDED_DESC,
          });
          const firstDateAddedPage = yield* Effect.promise(() =>
            client.listLibrary(dateAddedRequest, requestOptions),
          );
          expect(firstDateAddedPage.items).toHaveLength(1);
          expect(firstDateAddedPage.nextPageToken).not.toBe("");
          const secondDateAddedPage = yield* Effect.promise(() =>
            client.listLibrary(
              { ...dateAddedRequest, pageToken: firstDateAddedPage.nextPageToken },
              requestOptions,
            ),
          );
          expect(secondDateAddedPage.items.map(({ title }) => title)).toEqual(["Bravo"]);

          const filtered = yield* Effect.promise(() =>
            client.listLibrary(
              {
                filter: {
                  genre: "Mystery",
                  kinds: [MediaKind.MOVIE],
                  playableOnly: true,
                  releaseYear: 2025,
                  watchFilter: WatchFilter.ANY,
                },
                pageSize: 50,
                sort: LibrarySort.RELEASE_DATE_DESC,
              },
              requestOptions,
            ),
          );
          expect(filtered.items.map(({ title }) => title)).toEqual(["alpha"]);

          const complete = yield* Effect.promise(() =>
            client.listLibrary(
              {
                filter: { watchFilter: WatchFilter.ANY },
                pageSize: 50,
                sort: LibrarySort.TITLE_ASC,
              },
              requestOptions,
            ),
          );
          expect(complete.items.find(({ title }) => title === "Charlie")).toMatchObject({
            playability: Playability.NO_AVAILABLE_SOURCE,
          });

          const unavailableWatchState = yield* query
            .listLibrary(
              PRINCIPAL_ID,
              create(ListLibraryRequestSchema, {
                filter: { watchFilter: WatchFilter.UNWATCHED },
                sort: LibrarySort.DATE_ADDED_DESC,
              }),
            )
            .pipe(Effect.flip);
          expect(unavailableWatchState).toMatchObject({ _tag: "MediaStateUnavailable" });

          const crossPrincipal = yield* captureConnectFailure(() =>
            client.listLibrary(
              { ...firstPageRequest, pageToken: firstPage.nextPageToken },
              otherRequestOptions,
            ),
          );
          expect(crossPrincipal.code).toBe(Code.InvalidArgument);
          expect(crossPrincipal.findDetails(ErrorInfoSchema)).toMatchObject([
            { reason: "PAGE_TOKEN_INVALID" },
          ]);

          currentTime += 15 * 60 * 1000 + 1;
          const expired = yield* captureConnectFailure(() =>
            client.listLibrary(
              { ...firstPageRequest, pageToken: firstPage.nextPageToken },
              requestOptions,
            ),
          );
          expect(expired.code).toBe(Code.InvalidArgument);
          expect(expired.findDetails(ErrorInfoSchema)).toMatchObject([
            { reason: "PAGE_TOKEN_INVALID" },
          ]);
        }),
      );
    }),
  ),
);

it.live("distinguishes empty, incomplete, and previously completed catalogs", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* catalogReadiness() {
      yield* initializeCatalogDatabase(databaseUrl, []);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryEmptyCatalog() {
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const empty = yield* Effect.promise(() => client.getHome({}, requestOptions));
          expect(empty.sections.map(({ items }) => items)).toEqual([[], []]);
        }),
      );

      const loadingProviderId = "catalog-loading-instance";
      yield* initializeCatalogDatabase(databaseUrl, [{ id: loadingProviderId, priority: 1 }]);
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `INSERT INTO provider_catalog_scan_state (
               captured_provider_revision, completed_at, core_run_id, next_retry_at,
               provider_instance_id, safe_failure_reason, started_at, status, updated_at
             ) VALUES (
               $1, $2, 'loading-run', $3, $4, 'provider_unavailable', $5, 'failed', $2
             )`,
            [
              `${loadingProviderId}-revision`,
              new Date(NOW),
              new Date(NOW + 30_000),
              loadingProviderId,
              new Date(NOW - 60_000),
            ],
          ),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(
          movieObservation(loadingProviderId, {
            itemReference: "private-partial-import",
            title: "Partial Import Movie",
          }),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryLoadingCatalog() {
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const loading = yield* captureConnectFailure(() => client.getHome({}, requestOptions));
          expect(loading.code).toBe(Code.Unavailable);
          expect(loading.findDetails(ErrorInfoSchema)).toMatchObject([
            { reason: "CATALOG_NOT_READY" },
          ]);
        }),
      );

      const completedProviderId = "catalog-completed-instance";
      yield* initializeCatalogDatabase(databaseUrl, [{ id: completedProviderId, priority: 2 }]);
      yield* markProviderHealthy(databaseUrl, completedProviderId);
      yield* markCatalogComplete(databaseUrl, completedProviderId);
      const completedItem = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.catalog.observeItem(
          movieObservation(completedProviderId, {
            itemReference: "private-completed-import",
            title: "Completed Import Movie",
          }),
        ),
      );
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query("UPDATE provider_instance SET enabled = false WHERE id = $1", [
            completedProviderId,
          ]),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryPreviouslyCompletedCatalog() {
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const response = yield* Effect.promise(() =>
            client.getMedia({ mediaId: completedItem.id }, requestOptions),
          );
          expect(response.media?.summary?.id).toBe(completedItem.id);
        }),
      );
    }),
  ),
);

it.live("removes one shared source and then the final source through public Library reads", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* publicSourceDeletion() {
      const firstProviderId = "catalog-source-provider-a";
      const secondProviderId = "catalog-source-provider-b";
      yield* initializeCatalogDatabase(
        databaseUrl,
        [
          { id: firstProviderId, priority: 1 },
          { id: secondProviderId, priority: 2 },
        ],
        true,
      );
      yield* markProviderHealthy(databaseUrl, firstProviderId);
      yield* markProviderHealthy(databaseUrl, secondProviderId);
      yield* markCatalogComplete(databaseUrl, firstProviderId);
      yield* markCatalogComplete(databaseUrl, secondProviderId);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* deleteStoredSources() {
          const first = yield* database.catalog.observeItem(
            movieObservation(firstProviderId, {
              itemReference: "private-shared-source-a",
              sources: [
                videoSource(
                  "private-shared-source-a",
                  "private-shared-part-a",
                  "private-shared-track-a",
                ),
              ],
              title: "Shared Source Movie",
            }),
          );
          yield* database.catalog.observeItem(
            movieObservation(secondProviderId, {
              itemReference: "private-shared-source-b",
              sources: [
                videoSource(
                  "private-shared-source-b",
                  "private-shared-part-b",
                  "private-shared-track-b",
                ),
              ],
              title: "Provider Duplicate",
            }),
          );
          yield* withPool(databaseUrl, (pool) =>
            retargetProviderMapping(pool, secondProviderId, first.id),
          );
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const beforeDeletion = yield* Effect.promise(() =>
            client.getMedia({ mediaId: first.id }, requestOptions),
          );
          expect(beforeDeletion.media?.sourceSummaries).toHaveLength(2);

          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query("UPDATE provider_instance SET enabled = false WHERE id = $1", [
                secondProviderId,
              ]),
            ),
          );
          expect(
            yield* database.providers.deleteInstance({
              expectedRevision: `${secondProviderId}-revision`,
              operation: {
                administratorUserId: ADMINISTRATOR_ID,
                canonicalRequest: new TextEncoder().encode(secondProviderId),
                method: "nama.api.v1.ProviderService.DeleteProviderInstance",
                operationId: "delete-second-source-provider",
                serializedResult: {},
              },
              providerInstanceId: secondProviderId,
            }),
          ).toBe(true);
          const afterOneDeletion = yield* Effect.promise(() =>
            client.getMedia({ mediaId: first.id }, requestOptions),
          );
          expect(afterOneDeletion.media?.sourceSummaries).toHaveLength(1);

          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query("UPDATE provider_instance SET enabled = false WHERE id = $1", [
                firstProviderId,
              ]),
            ),
          );
          expect(
            yield* database.providers.deleteInstance({
              expectedRevision: `${firstProviderId}-revision`,
              operation: {
                administratorUserId: ADMINISTRATOR_ID,
                canonicalRequest: new TextEncoder().encode(firstProviderId),
                method: "nama.api.v1.ProviderService.DeleteProviderInstance",
                operationId: "delete-final-source-provider",
                serializedResult: {},
              },
              providerInstanceId: firstProviderId,
            }),
          ).toBe(true);
          const finalSource = yield* captureConnectFailure(() =>
            client.getMedia({ mediaId: first.id }, requestOptions),
          );
          expect(finalSource.code).toBe(Code.NotFound);
          expect(finalSource.findDetails(ErrorInfoSchema)).toMatchObject([
            { reason: "RESOURCE_NOT_FOUND" },
          ]);
        }),
      );
    }),
  ),
);
it.live("ranks prefix search in PostgreSQL and keyset-paginates equal query state", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedSearch() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* markProviderHealthy(databaseUrl, PROVIDER_INSTANCE_ID);

      yield* markCatalogComplete(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryStoredSearch() {
          const observations = [
            movieObservation(PROVIDER_INSTANCE_ID, {
              credits: [],
              genres: ["Drama"],
              itemReference: "private-search-title",
              originalTitle: undefined,
              sources: [
                videoSource(
                  "private-search-title-source",
                  "private-search-title-part",
                  "private-search-title-track",
                ),
              ],
              title: "Orbit Title",
            }),
            movieObservation(PROVIDER_INSTANCE_ID, {
              credits: [],
              genres: ["Drama"],
              itemReference: "private-search-original",
              originalTitle: "Orbit Original",
              sources: [
                videoSource(
                  "private-search-original-source",
                  "private-search-original-part",
                  "private-search-original-track",
                ),
              ],
              title: "Zulu Original",
            }),
            movieObservation(PROVIDER_INSTANCE_ID, {
              credits: [{ name: "Orbit Actor", role: "actor" }],
              genres: ["Drama"],
              itemReference: "private-search-cast",
              originalTitle: undefined,
              sources: [
                videoSource(
                  "private-search-cast-source",
                  "private-search-cast-part",
                  "private-search-cast-track",
                ),
              ],
              title: "Alpha Cast",
            }),
            movieObservation(PROVIDER_INSTANCE_ID, {
              credits: [],
              genres: ["Orbit Genre"],
              itemReference: "private-search-genre",
              originalTitle: undefined,
              sources: [
                videoSource(
                  "private-search-genre-source",
                  "private-search-genre-part",
                  "private-search-genre-track",
                ),
              ],
              title: "Alpha Genre",
            }),
          ];
          // oxlint-disable-next-line unicorn/no-array-method-this-argument -- Effect.forEach's callback is not an Array thisArg.
          yield* Effect.forEach(observations, (observation) =>
            database.catalog.observeItem(observation),
          );
          const query = yield* makeStoredQuery(database);
          const client = yield* startCatalogClient(database, query);
          const request = create(SearchRequestSchema, {
            pageSize: 2,
            query: "  ORB  ",
          });
          const firstPage = yield* Effect.promise(() => client.search(request, requestOptions));
          expect(firstPage.items.map(({ title }) => title)).toEqual([
            "Orbit Title",
            "Zulu Original",
          ]);
          expect(firstPage.nextPageToken).not.toBe("");
          expect(firstPage.nextPageToken).not.toContain("private-search");

          const secondPage = yield* Effect.promise(() =>
            client.search({ ...request, pageToken: firstPage.nextPageToken }, requestOptions),
          );
          expect(secondPage.items.map(({ title }) => title)).toEqual(["Alpha Cast", "Alpha Genre"]);

          const fuzzy = yield* Effect.promise(() =>
            client.search({ query: "orbot" }, requestOptions),
          );
          expect(fuzzy.items).toEqual([]);

          const changedQuery = yield* captureConnectFailure(() =>
            client.search(
              {
                pageSize: 2,
                pageToken: firstPage.nextPageToken,
                query: "different",
              },
              requestOptions,
            ),
          );
          expect(changedQuery.code).toBe(Code.InvalidArgument);
          expect(changedQuery.findDetails(ErrorInfoSchema)).toMatchObject([
            { reason: "PAGE_TOKEN_INVALID" },
          ]);
        }),
      );
    }),
  ),
);

it.live("serves visible hierarchy, canonical details, and technical sources by Nama ID", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedHierarchy() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* markProviderHealthy(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* markCatalogComplete(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* queryStoredHierarchy() {
          const season = yield* database.catalog.observeItem(
            seasonObservation(PROVIDER_INSTANCE_ID),
          );
          const query = yield* makeStoredQuery(database);
          const unresolved = yield* query
            .getMedia(PRINCIPAL_ID, create(GetMediaRequestSchema, { mediaId: season.id }))
            .pipe(Effect.flip);
          expect(unresolved).toMatchObject({ _tag: "ResourceNotFound" });

          const show = yield* database.catalog.observeItem(showObservation(PROVIDER_INSTANCE_ID));
          const episode = yield* database.catalog.observeItem(
            episodeObservation(PROVIDER_INSTANCE_ID),
          );
          const showMedia = yield* query.getMedia(
            PRINCIPAL_ID,
            create(GetMediaRequestSchema, { mediaId: show.id }),
          );
          expect(showMedia.media).toMatchObject({
            kindDetails: {
              case: "show",
              value: { episodeCount: 10, seasonCount: 1 },
            },
            summary: {
              id: show.id,
              kind: MediaKind.SHOW,
              title: "Catalog Show",
            },
          });

          const showChildren = yield* query.listChildren(
            PRINCIPAL_ID,
            create(ListChildrenRequestSchema, { parentMediaId: show.id }),
          );
          expect(showChildren.items.map(({ id, title }) => ({ id, title }))).toEqual([
            { id: season.id, title: "Season One" },
          ]);
          const seasonChildren = yield* query.listChildren(
            PRINCIPAL_ID,
            create(ListChildrenRequestSchema, { parentMediaId: season.id }),
          );
          expect(seasonChildren.items.map(({ id, title }) => ({ id, title }))).toEqual([
            { id: episode.id, title: "Episode Two" },
          ]);

          const episodeMedia = yield* query.getMedia(
            PRINCIPAL_ID,
            create(GetMediaRequestSchema, { mediaId: episode.id }),
          );
          expect(episodeMedia.media?.parents.map(({ title }) => title)).toEqual([
            "Catalog Show",
            "Season One",
          ]);
          expect(episodeMedia.media?.kindDetails).toMatchObject({
            case: "episode",
            value: { episodeNumber: 2, seasonNumber: 1 },
          });

          const sourceId = episode.sources[0]?.id;
          expect(sourceId).toBeDefined();
          if (sourceId === undefined) {
            throw new Error("episode source fixture is missing");
          }
          const source = yield* query.getMediaSource(
            PRINCIPAL_ID,
            create(GetMediaSourceRequestSchema, {
              mediaId: episode.id,
              sourceId,
            }),
          );
          expect(source.source).toMatchObject({
            id: sourceId,
            mediaId: episode.id,
            parts: [
              {
                container: "mkv",
                order: 0,
                tracks: [
                  {
                    details: {
                      case: "video",
                      value: { codec: "hevc", height: 2160, width: 3840 },
                    },
                    order: 0,
                  },
                ],
              },
            ],
          });

          const movie = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              itemReference: "private-no-children-movie",
              sources: [
                videoSource(
                  "private-no-children-source",
                  "private-no-children-part",
                  "private-no-children-track",
                ),
              ],
            }),
          );
          const noChildren = yield* query
            .listChildren(
              PRINCIPAL_ID,
              create(ListChildrenRequestSchema, { parentMediaId: movie.id }),
            )
            .pipe(Effect.flip);
          expect(noChildren).toMatchObject({ _tag: "MediaHasNoChildren" });

          const publicJson = JSON.stringify(
            { episodeMedia, showChildren, source },
            (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
          );
          expect(publicJson).not.toContain("private-episode");
          expect(publicJson).not.toContain(PROVIDER_INSTANCE_ID);
        }),
      );
    }),
  ),
);

it.live("resolves only persisted canonical artwork assets through Nama locators", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* storedArtworkResolution() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* markProviderHealthy(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* markCatalogComplete(databaseUrl, PROVIDER_INSTANCE_ID);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* resolveStoredArtwork() {
          const movie = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              artwork: [
                {
                  artworkReference: "private-artwork-reference",
                  asset: { bytes: Buffer.from("canonical-image"), mimeType: "image/jpeg" },
                  height: 1500,
                  role: "poster",
                  textPresence: "contains_text",
                  width: 1000,
                },
              ],
              itemReference: "private-artwork-item",
            }),
          );
          const artworkId = movie.artwork[0]?.id;
          if (artworkId === undefined) {
            throw new Error("artwork fixture is missing");
          }
          let resolutionCount = 0;
          const artworkAccess: ArtworkAccessService = {
            locator: ({ height, width }) => {
              resolutionCount += 1;
              return {
                $typeName: "nama.api.v1.ArtworkLocator",
                accessExpiresAt: undefined,
                allowedRedirectOrigins: ["https://nama.example"],
                headers: [],
                height,
                refreshAt: undefined,
                url: "https://nama.example/artwork/opaque-token",
                width,
              };
            },
            read: () => Effect.die("unexpected artwork byte read"),
          };
          const query = yield* makeStoredQuery(database, () => NOW, artworkAccess);
          yield* query.getHome(PRINCIPAL_ID, create(GetHomeRequestSchema, {}));
          expect(resolutionCount).toBe(0);

          const response = yield* query.resolveArtwork(
            PRINCIPAL_ID,
            create(ResolveArtworkRequestSchema, {
              artworkId,
              maxHeight: 900,
              maxWidth: 600,
            }),
          );
          expect(resolutionCount).toBe(1);
          expect(response.locator).toMatchObject({
            allowedRedirectOrigins: ["https://nama.example"],
            headers: [],
            height: 1500,
            url: "https://nama.example/artwork/opaque-token",
            width: 1000,
          });
          expect(
            JSON.stringify(response, (_key, value: unknown) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          ).not.toContain("private-artwork");

          const missingAssetMovie = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              artwork: [
                {
                  artworkReference: "missing-asset-reference",
                  role: "poster",
                  textPresence: "unknown",
                },
              ],
              itemReference: "missing-asset-item",
            }),
          );
          const missingAssetId = missingAssetMovie.artwork[0]?.id;
          if (missingAssetId === undefined) {
            throw new Error("missing-asset fixture has no artwork");
          }
          const missingAsset = yield* query
            .resolveArtwork(
              PRINCIPAL_ID,
              create(ResolveArtworkRequestSchema, { artworkId: missingAssetId }),
            )
            .pipe(Effect.flip);
          expect(missingAsset).toMatchObject({ _tag: "ResourceNotFound" });
          expect(resolutionCount).toBe(1);
        }),
      );
    }),
  ),
);

it.live("replaces and retires persisted artwork with its canonical projection", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* persistedArtworkLifecycle() {
      yield* initializeCatalogDatabase(databaseUrl, [{ id: PROVIDER_INSTANCE_ID, priority: 1 }]);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* replacePersistedArtwork() {
          const first = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              artwork: [
                {
                  artworkReference: "first-private-artwork",
                  asset: { bytes: Buffer.from("first-image"), mimeType: "image/jpeg" },
                  role: "poster",
                  textPresence: "unknown",
                },
              ],
              itemReference: "artwork-lifecycle-item",
            }),
          );
          const firstArtworkId = first.artwork[0]?.id;
          if (firstArtworkId === undefined) {
            throw new Error("first artwork fixture is missing");
          }
          const firstTarget = yield* Effect.promise(() =>
            database.catalogQueries.getArtworkTarget(firstArtworkId),
          );
          expect(firstTarget).toMatchObject({
            assetBytes: Buffer.from("first-image"),
            assetMimeType: "image/jpeg",
          });

          const replacement = yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              artwork: [
                {
                  artworkReference: "replacement-private-artwork",
                  asset: { bytes: Buffer.from("replacement-image"), mimeType: "image/png" },
                  role: "poster",
                  textPresence: "unknown",
                },
              ],
              itemReference: "artwork-lifecycle-item",
            }),
          );
          const replacementArtworkId = replacement.artwork[0]?.id;
          if (replacementArtworkId === undefined) {
            throw new Error("replacement artwork fixture is missing");
          }
          expect(replacementArtworkId).not.toBe(firstArtworkId);
          const retiredFirst = yield* Effect.promise(() =>
            database.catalogQueries.getArtworkTarget(firstArtworkId),
          );
          expect(retiredFirst).toBeUndefined();
          const replacementTarget = yield* Effect.promise(() =>
            database.catalogQueries.getArtworkTarget(replacementArtworkId),
          );
          expect(replacementTarget).toMatchObject({
            assetBytes: Buffer.from("replacement-image"),
            assetMimeType: "image/png",
          });

          yield* database.catalog.observeItem(
            movieObservation(PROVIDER_INSTANCE_ID, {
              artwork: [],
              itemReference: "artwork-lifecycle-item",
            }),
          );
          const retiredReplacement = yield* Effect.promise(() =>
            database.catalogQueries.getArtworkTarget(replacementArtworkId),
          );
          expect(retiredReplacement).toBeUndefined();
        }),
      );
    }),
  ),
);
