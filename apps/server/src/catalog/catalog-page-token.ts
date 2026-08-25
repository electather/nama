import { Effect } from "effect";

import { LibrarySort, WatchFilter } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { ListLibraryRequest } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import { MediaKind } from "../../../../gen/ts/src/nama/api/v1/media_pb.js";
import type { CatalogMediaKind } from "../database/catalog-persistence-model-private.ts";
import type {
  CatalogChildrenCursor,
  CatalogLibraryCursor,
  CatalogLibraryQuery,
  CatalogSearchCursor,
  StoredCatalogSearchResult,
  StoredCatalogSummary,
} from "../database/catalog-query-storage.ts";
import { PageTokenInvalid } from "../provider/page-token.ts";
import type { PageTokenCodec, PageTokenInvalidFailure } from "../provider/page-token.ts";

const ABSENT_INDEX = -1;
const DEFAULT_PAGE_SIZE = 50;
const LIST_CHILDREN_METHOD = "nama.api.v1.LibraryService.ListChildren";
const LIST_LIBRARY_METHOD = "nama.api.v1.LibraryService.ListLibrary";
const PAGE_TOKEN_LIFETIME_MILLISECONDS = 900_000;
const SEARCH_METHOD = "nama.api.v1.LibraryService.Search";
const ZERO = 0;

const ABSENT_VALUE = undefined;
const CATALOG_KIND_BY_MEDIA_KIND: Readonly<Partial<Record<MediaKind, CatalogMediaKind>>> =
  Object.freeze({
    [MediaKind.EPISODE]: "episode",
    [MediaKind.MOVIE]: "movie",
    [MediaKind.SEASON]: "season",
    [MediaKind.SHOW]: "show",
  });

const catalogKinds = (kinds: readonly MediaKind[]): readonly CatalogMediaKind[] =>
  kinds
    .map((kind) => CATALOG_KIND_BY_MEDIA_KIND[kind])
    .filter((kind): kind is CatalogMediaKind => kind !== undefined)
    .toSorted();

const catalogLibrarySort = (sort: LibrarySort): CatalogLibraryQuery["sort"] => {
  switch (sort) {
    case LibrarySort.RELEASE_DATE_DESC: {
      return "release_date";
    }
    case LibrarySort.DATE_ADDED_DESC: {
      return "date_added";
    }
    case LibrarySort.TITLE_ASC:
    case LibrarySort.UNSPECIFIED: {
      return "title";
    }
    default: {
      throw new PageTokenInvalid({});
    }
  }
};

const normalizedLibraryQuery = (
  request: ListLibraryRequest,
  kinds: readonly CatalogMediaKind[],
): string =>
  JSON.stringify({
    filter: {
      genre: request.filter?.genre,
      kinds,
      playable_only: request.filter?.playableOnly ?? false,
      release_year: request.filter?.releaseYear,
      watch_filter: request.filter?.watchFilter ?? WatchFilter.ANY,
    },
    sort: request.sort,
  });

const pageTokenFailure = (error: unknown): PageTokenInvalidFailure => {
  if (error instanceof PageTokenInvalid) {
    return error;
  }
  return new PageTokenInvalid({});
};

interface PageCursorBindings {
  readonly method: string;
  readonly now: number;
  readonly pageSize: number;
  readonly principalId: string;
  readonly query: string;
}

interface PageCursorDecodeInput extends PageCursorBindings {
  readonly token: string;
}

interface PageSlice<Item> {
  readonly hasNextPage: boolean;
  readonly items: readonly Item[];
  readonly lastItem: Item | undefined;
}

const decodePageCursor = <Cursor>(
  pageTokens: PageTokenCodec,
  input: PageCursorDecodeInput,
  parse: (cursorValue: string) => Cursor,
): Effect.Effect<Cursor | undefined, PageTokenInvalidFailure> => {
  if (input.token.length === ZERO) {
    return Effect.succeed(ABSENT_VALUE);
  }
  return Effect.try({
    catch: pageTokenFailure,
    try: () => parse(pageTokens.decode(input)),
  });
};

const encodePageCursor = (
  pageTokens: PageTokenCodec,
  bindings: PageCursorBindings,
  cursor: string,
): Effect.Effect<string, PageTokenInvalidFailure> =>
  Effect.try({
    catch: pageTokenFailure,
    try: () =>
      pageTokens.encode({
        ...bindings,
        cursor,
        expiresAt: bindings.now + PAGE_TOKEN_LIFETIME_MILLISECONDS,
      }),
  });

const slicePage = <Item>(rows: readonly Item[], pageSize: number): PageSlice<Item> => {
  if (rows.length <= pageSize) {
    return { hasNextPage: false, items: rows, lastItem: rows.at(ABSENT_INDEX) };
  }
  const items = rows.slice(ZERO, pageSize);
  return { hasNextPage: true, items, lastItem: items.at(ABSENT_INDEX) };
};

const property = (value: object, key: string): unknown => {
  if (!Object.hasOwn(value, key)) {
    return ABSENT_VALUE;
  }
  return Reflect.get(value, key);
};

interface ParsedCursorObject {
  readonly id: string;
  readonly value: object;
}

const parsedCursorObject = (cursorValue: string): ParsedCursorObject => {
  const value: unknown = JSON.parse(cursorValue);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PageTokenInvalid({});
  }
  const id = property(value, "id");
  if (typeof id !== "string") {
    throw new PageTokenInvalid({});
  }
  return { id, value };
};

const titleCursor = (properties: object, id: string): CatalogLibraryCursor => {
  const normalizedTitle = property(properties, "normalized_title");
  if (typeof normalizedTitle !== "string") {
    throw new PageTokenInvalid({});
  }
  return { id, normalizedTitle, sort: "title" };
};

const releaseDateCursor = (properties: object, id: string): CatalogLibraryCursor => {
  const releaseDate = property(properties, "release_date");
  if (releaseDate !== null && typeof releaseDate !== "string") {
    throw new PageTokenInvalid({});
  }
  return { id, releaseDate, sort: "release_date" };
};

const dateAddedCursor = (properties: object, id: string): CatalogLibraryCursor => {
  const createdAtRaw = property(properties, "created_at");
  if (typeof createdAtRaw !== "string") {
    throw new PageTokenInvalid({});
  }
  const createdAt = new Date(createdAtRaw);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== createdAtRaw) {
    throw new PageTokenInvalid({});
  }
  return { createdAt, id, sort: "date_added" };
};

const libraryCursorFromJson = (
  cursorValue: string,
  expectedSort: CatalogLibraryQuery["sort"],
): CatalogLibraryCursor => {
  const { id, value } = parsedCursorObject(cursorValue);
  const sort = property(value, "sort");
  if (sort !== expectedSort) {
    throw new PageTokenInvalid({});
  }
  switch (expectedSort) {
    case "title": {
      return titleCursor(value, id);
    }
    case "release_date": {
      return releaseDateCursor(value, id);
    }
    case "date_added": {
      return dateAddedCursor(value, id);
    }
    default: {
      throw new PageTokenInvalid({});
    }
  }
};

const libraryCursorJson = (
  item: StoredCatalogSummary,
  sort: CatalogLibraryQuery["sort"],
): string => {
  switch (sort) {
    case "title": {
      return JSON.stringify({ id: item.id, normalized_title: item.normalizedTitle, sort });
    }
    case "release_date": {
      return JSON.stringify({ id: item.id, release_date: item.releaseDateSort, sort });
    }
    case "date_added": {
      return JSON.stringify({
        created_at: item.libraryCreatedAt.toISOString(),
        id: item.id,
        sort,
      });
    }
    default: {
      throw new PageTokenInvalid({});
    }
  }
};

const searchCursorFromJson = (cursorValue: string): CatalogSearchCursor => {
  const { id, value } = parsedCursorObject(cursorValue);
  const normalizedTitle = property(value, "normalized_title");
  const rank = property(value, "rank");
  if (
    typeof normalizedTitle !== "string" ||
    typeof rank !== "number" ||
    !Number.isFinite(rank) ||
    rank <= ZERO
  ) {
    throw new PageTokenInvalid({});
  }
  return { id, normalizedTitle, rank };
};

const searchCursorJson = (item: StoredCatalogSearchResult): string =>
  JSON.stringify({ id: item.id, normalized_title: item.normalizedTitle, rank: item.searchRank });

const childrenCursorFromJson = (cursorValue: string): CatalogChildrenCursor => {
  const { id, value } = parsedCursorObject(cursorValue);
  const position = property(value, "position");
  if (typeof position !== "number" || !Number.isSafeInteger(position) || position <= ZERO) {
    throw new PageTokenInvalid({});
  }
  return { id, position };
};

const childPosition = (item: StoredCatalogSummary): number => {
  let position = item.episodeNumber;
  if (item.kind === "season") {
    position = item.seasonNumber;
  }
  if (position === null) {
    throw new Error("stored child position is missing");
  }
  return position;
};

export {
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
};
export type { PageCursorBindings, PageCursorDecodeInput, PageSlice };
