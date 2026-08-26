import { create } from "@bufbuild/protobuf";
import { Effect } from "effect";

import {
  GetHomeResponseSchema,
  GetMediaResponseSchema,
  GetMediaSourceResponseSchema,
  HomeSectionKind,
} from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { StoredCatalogItem } from "../database/catalog-persistence-model-private.ts";
import { PageTokenInvalid, makePageTokenCodec } from "../provider/page-token.ts";
import type { PageTokenInvalidFailure } from "../provider/page-token.ts";
import { makeResolveArtwork } from "./catalog-artwork-query.ts";
import {
  detailsMessage,
  summaryMessage,
  technicalSourceMessage,
} from "./catalog-media-messages.ts";
import { makeListChildren, makeListLibrary, makeSearch } from "./catalog-paged-queries.ts";
import {
  CatalogQueryPersistenceError,
  ResourceNotFound,
  SourceUnavailable,
} from "./catalog-query-model.ts";
import type {
  CatalogArtworkLeaseResolver,
  CatalogQueryDependencies,
  CatalogQueryPersistenceFailure,
  CatalogQueryService,
  ResourceNotFoundFailure,
} from "./catalog-query-model.ts";
import { ensureCatalogReady } from "./catalog-readiness.ts";

const DEFAULT_HOME_SECTION_SIZE = 20;
const SOURCE_RETRY_DELAY_MILLISECONDS = 5000;
const ZERO = 0;

const pageTokenFailure = (error: unknown): PageTokenInvalidFailure => {
  if (error instanceof PageTokenInvalid) {
    return error;
  }
  return new PageTokenInvalid({});
};

const loadCatalogItem = (
  catalog: CatalogQueryDependencies["catalog"],
  mediaId: string,
): Effect.Effect<StoredCatalogItem, CatalogQueryPersistenceFailure | ResourceNotFoundFailure> =>
  Effect.tryPromise({
    catch: () => new CatalogQueryPersistenceError({}),
    try: () => catalog.getItem(mediaId),
  }).pipe(
    Effect.flatMap((item) => {
      if (item === undefined) {
        return Effect.fail(new ResourceNotFound({}));
      }
      return Effect.succeed(item);
    }),
  );

const makeGetMedia =
  (dependencies: CatalogQueryDependencies): CatalogQueryService["getMedia"] =>
  (_principalId, request) =>
    Effect.gen(function* getStoredMedia() {
      yield* ensureCatalogReady(dependencies, dependencies.now());
      const item = yield* loadCatalogItem(dependencies.catalog, request.mediaId);
      return create(GetMediaResponseSchema, { media: detailsMessage(item) });
    });

const makeGetMediaSource =
  (dependencies: CatalogQueryDependencies): CatalogQueryService["getMediaSource"] =>
  (_principalId, request) =>
    Effect.gen(function* getStoredMediaSource() {
      yield* ensureCatalogReady(dependencies, dependencies.now());
      const item = yield* loadCatalogItem(dependencies.catalog, request.mediaId);
      const source = item.sources.find((candidate) => candidate.id === request.sourceId);
      if (source === undefined) {
        return yield* Effect.fail(new ResourceNotFound({}));
      }
      if (source.availability === "provider_unavailable") {
        return yield* Effect.fail(
          new SourceUnavailable({ retryDelayMilliseconds: SOURCE_RETRY_DELAY_MILLISECONDS }),
        );
      }
      if (source.availability === "unsupported") {
        return yield* Effect.fail(new SourceUnavailable({}));
      }
      return create(GetMediaSourceResponseSchema, {
        source: technicalSourceMessage(item.id, source),
      });
    });

const makeGetHome =
  (dependencies: CatalogQueryDependencies): CatalogQueryService["getHome"] =>
  (_principalId, request) =>
    Effect.gen(function* getStoredHome() {
      let sectionSize = request.sectionSize ?? DEFAULT_HOME_SECTION_SIZE;
      if (sectionSize === ZERO) {
        sectionSize = DEFAULT_HOME_SECTION_SIZE;
      }
      yield* ensureCatalogReady(dependencies, dependencies.now());
      const home = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () => dependencies.catalog.loadHome(sectionSize),
      });
      return create(GetHomeResponseSchema, {
        sections: [
          {
            id: "movies",
            items: home.movies.map((item) => summaryMessage(item)),
            kind: HomeSectionKind.MOVIES,
            title: "Movies",
          },
          {
            id: "shows",
            items: home.shows.map((item) => summaryMessage(item)),
            kind: HomeSectionKind.SHOWS,
            title: "Shows",
          },
        ],
      });
    });

const makeCatalogQuery = (dependencies: CatalogQueryDependencies) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: pageTokenFailure,
      try: () => makePageTokenCodec(dependencies.masterKey),
    }),
    (pageTokens) => Effect.sync(pageTokens.close),
  ).pipe(
    Effect.map((pageTokens): CatalogQueryService => ({
      getHome: makeGetHome(dependencies),
      getMedia: makeGetMedia(dependencies),
      getMediaSource: makeGetMediaSource(dependencies),
      listChildren: makeListChildren(dependencies, pageTokens),
      listLibrary: makeListLibrary(dependencies, pageTokens),
      resolveArtwork: makeResolveArtwork(dependencies),
      search: makeSearch(dependencies, pageTokens),
    })),
  );

export { makeCatalogQuery };
export type { CatalogArtworkLeaseResolver, CatalogQueryDependencies };
