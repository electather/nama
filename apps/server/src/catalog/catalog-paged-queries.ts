import { create } from "@bufbuild/protobuf";
import { Effect } from "effect";

import {
  ListChildrenResponseSchema,
  ListLibraryResponseSchema,
  SearchResponseSchema,
  WatchFilter,
} from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { ListChildrenRequest } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type {
  CatalogChildrenCursor,
  CatalogLibraryQuery,
  StoredCatalogSearchResult,
  StoredCatalogSummary,
} from "../database/catalog-query-storage.ts";
import type { PageTokenCodec } from "../provider/page-token.ts";
import {
  DEFAULT_PAGE_SIZE,
  LIST_CHILDREN_METHOD,
  LIST_LIBRARY_METHOD,
  SEARCH_METHOD,
  catalogKinds,
  catalogLibrarySort,
  childPosition,
  childrenCursorFromJson,
  decodePageCursor,
  encodePageCursor,
  libraryCursorFromJson,
  libraryCursorJson,
  normalizedLibraryQuery,
  searchCursorFromJson,
  searchCursorJson,
  slicePage,
} from "./catalog-page-token.ts";
import type { PageCursorBindings } from "./catalog-page-token.ts";
import {
  CatalogQueryPersistenceError,
  MediaHasNoChildren,
  MediaStateUnavailable,
  ResourceNotFound,
  SearchQueryInvalid,
} from "./catalog-query-model.ts";
import type { CatalogQueryDependencies, CatalogQueryService } from "./catalog-query-model.ts";
import { ensureCatalogReady } from "./catalog-readiness.ts";
import { summaryMessage } from "./catalog-summary-messages.ts";

const NEXT_PAGE_ITEM_COUNT = 1;
const ZERO = 0;

const normalizedPageSize = (requested: number): number => {
  if (requested === ZERO) {
    return DEFAULT_PAGE_SIZE;
  }
  return requested;
};

interface LibraryPageInput {
  readonly bindings: PageCursorBindings;
  readonly pageSize: number;
  readonly rows: readonly StoredCatalogSummary[];
  readonly sort: CatalogLibraryQuery["sort"];
}

interface SearchPageInput {
  readonly bindings: PageCursorBindings;
  readonly pageSize: number;
  readonly rows: readonly StoredCatalogSearchResult[];
}

interface ChildrenPageInput {
  readonly bindings: PageCursorBindings;
  readonly pageSize: number;
  readonly rows: readonly StoredCatalogSummary[];
}

const nextLibraryToken = (pageTokens: PageTokenCodec, input: LibraryPageInput) => {
  const page = slicePage(input.rows, input.pageSize);
  if (!page.hasNextPage || page.lastItem === undefined) {
    return Effect.succeed({ items: page.items, token: "" });
  }
  return encodePageCursor(
    pageTokens,
    input.bindings,
    libraryCursorJson(page.lastItem, input.sort),
  ).pipe(Effect.map((token) => ({ items: page.items, token })));
};

const nextSearchToken = (pageTokens: PageTokenCodec, input: SearchPageInput) => {
  const page = slicePage(input.rows, input.pageSize);
  if (!page.hasNextPage || page.lastItem === undefined) {
    return Effect.succeed({ items: page.items, token: "" });
  }
  return encodePageCursor(pageTokens, input.bindings, searchCursorJson(page.lastItem)).pipe(
    Effect.map((token) => ({ items: page.items, token })),
  );
};

const makeListLibrary =
  (
    dependencies: CatalogQueryDependencies,
    pageTokens: PageTokenCodec,
  ): CatalogQueryService["listLibrary"] =>
  (principalId, request) => {
    const watchFilter = request.filter?.watchFilter ?? WatchFilter.ANY;
    if (watchFilter !== WatchFilter.ANY) {
      return Effect.fail(new MediaStateUnavailable({}));
    }
    const pageSize = normalizedPageSize(request.pageSize);
    const kinds = catalogKinds(request.filter?.kinds ?? []);
    const sort = catalogLibrarySort(request.sort);
    const query = normalizedLibraryQuery(request, kinds);
    const now = dependencies.now();
    const bindings = { method: LIST_LIBRARY_METHOD, now, pageSize, principalId, query };
    return Effect.gen(function* listStoredLibrary() {
      const cursor = yield* decodePageCursor(
        pageTokens,
        { ...bindings, token: request.pageToken },
        (cursorValue) => libraryCursorFromJson(cursorValue, sort),
      );
      yield* ensureCatalogReady(dependencies, now);
      const rows = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () =>
          dependencies.catalog.listLibrary({
            cursor,
            genre: request.filter?.genre,
            kinds,
            limit: pageSize + NEXT_PAGE_ITEM_COUNT,
            playableOnly: request.filter?.playableOnly ?? false,
            releaseYear: request.filter?.releaseYear,
            sort,
          }),
      });
      const page = yield* nextLibraryToken(pageTokens, {
        bindings,
        pageSize,
        rows,
        sort,
      });
      return create(ListLibraryResponseSchema, {
        items: page.items.map((item) => summaryMessage(item)),
        nextPageToken: page.token,
      });
    });
  };

const makeSearch =
  (
    dependencies: CatalogQueryDependencies,
    pageTokens: PageTokenCodec,
  ): CatalogQueryService["search"] =>
  (principalId, request) => {
    const normalizedQuery = request.query.trim().replaceAll(/\s+/gu, " ").toLowerCase();
    if (normalizedQuery.length === ZERO) {
      return Effect.fail(new SearchQueryInvalid({}));
    }
    const pageSize = normalizedPageSize(request.pageSize);
    const kinds = catalogKinds(request.kinds);
    const query = JSON.stringify({ kinds, query: normalizedQuery });
    const now = dependencies.now();
    const bindings = { method: SEARCH_METHOD, now, pageSize, principalId, query };
    return Effect.gen(function* searchStoredCatalog() {
      const cursor = yield* decodePageCursor(
        pageTokens,
        { ...bindings, token: request.pageToken },
        searchCursorFromJson,
      );
      yield* ensureCatalogReady(dependencies, now);
      const rows = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () =>
          dependencies.catalog.search({
            cursor,
            kinds,
            limit: pageSize + NEXT_PAGE_ITEM_COUNT,
            query: normalizedQuery,
          }),
      });
      const page = yield* nextSearchToken(pageTokens, { bindings, pageSize, rows });
      return create(SearchResponseSchema, {
        items: page.items.map((item) => summaryMessage(item)),
        nextPageToken: page.token,
      });
    });
  };

const childStorageInput = (
  request: ListChildrenRequest,
  cursor: CatalogChildrenCursor | undefined,
  pageSize: number,
) => {
  const input = {
    limit: pageSize + NEXT_PAGE_ITEM_COUNT,
    parentMediaId: request.parentMediaId,
  };
  if (cursor === undefined) {
    return input;
  }
  return { ...input, cursor };
};

const nextChildrenToken = (pageTokens: PageTokenCodec, input: ChildrenPageInput) => {
  const { hasNextPage, items, lastItem } = slicePage(input.rows, input.pageSize);
  if (!hasNextPage || lastItem === undefined) {
    return Effect.succeed({ items, token: "" });
  }
  return Effect.try({
    catch: () => new CatalogQueryPersistenceError({}),
    try: () => JSON.stringify({ id: lastItem.id, position: childPosition(lastItem) }),
  }).pipe(
    Effect.flatMap((cursor) => encodePageCursor(pageTokens, input.bindings, cursor)),
    Effect.map((token) => ({ items, token })),
  );
};

const makeListChildren =
  (
    dependencies: CatalogQueryDependencies,
    pageTokens: PageTokenCodec,
  ): CatalogQueryService["listChildren"] =>
  (principalId, request) => {
    const pageSize = normalizedPageSize(request.pageSize);
    const query = JSON.stringify({ parent_media_id: request.parentMediaId });
    const now = dependencies.now();
    const bindings = { method: LIST_CHILDREN_METHOD, now, pageSize, principalId, query };
    return Effect.gen(function* listStoredChildren() {
      const cursor = yield* decodePageCursor(
        pageTokens,
        { ...bindings, token: request.pageToken },
        childrenCursorFromJson,
      );
      yield* ensureCatalogReady(dependencies, now);
      const page = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () => dependencies.catalog.listChildren(childStorageInput(request, cursor, pageSize)),
      });
      if (page.parentKind === undefined) {
        return yield* Effect.fail(new ResourceNotFound({}));
      }
      if (page.parentKind !== "show" && page.parentKind !== "season") {
        return yield* Effect.fail(new MediaHasNoChildren({}));
      }
      const result = yield* nextChildrenToken(pageTokens, {
        bindings,
        pageSize,
        rows: page.children,
      });
      return create(ListChildrenResponseSchema, {
        items: result.items.map((item) => summaryMessage(item)),
        nextPageToken: result.token,
      });
    });
  };

export { makeListChildren, makeListLibrary, makeSearch };
