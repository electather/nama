import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { canonicalItem, libraryEntry } from "./catalog-item-schema.ts";
import type { CatalogMediaKind, CatalogTransaction } from "./catalog-persistence-model-private.ts";
import { mediaSource } from "./catalog-source-schema.ts";
import type { StoredCatalogSummary } from "./catalog-summary-model-private.ts";
import { storedSummary } from "./catalog-summary-read-model-private.ts";
import { summarySelection } from "./catalog-summary-selection-private.ts";
import { providerInstance, providerInstanceObservation } from "./provider-schema.ts";

const EMPTY_LENGTH = 0;

type CatalogLibrarySort = "date_added" | "release_date" | "title";
type CatalogLibraryCursor =
  | Readonly<{ readonly id: string; readonly normalizedTitle: string; readonly sort: "title" }>
  | Readonly<{
      readonly id: string;
      readonly releaseDate: string | null;
      readonly sort: "release_date";
    }>
  | Readonly<{ readonly createdAt: string; readonly id: string; readonly sort: "date_added" }>;

interface CatalogLibraryQuery {
  readonly cursor?: CatalogLibraryCursor | undefined;
  readonly genre?: string | undefined;
  readonly kinds: readonly CatalogMediaKind[];
  readonly limit: number;
  readonly playableOnly: boolean;
  readonly releaseYear?: number | undefined;
  readonly sort: CatalogLibrarySort;
}

interface CatalogSearchCursor {
  readonly id: string;
  readonly normalizedTitle: string;
  readonly rank: number;
}

interface CatalogSearchQuery {
  readonly cursor?: CatalogSearchCursor | undefined;
  readonly kinds: readonly CatalogMediaKind[];
  readonly limit: number;
  readonly query: string;
}

interface StoredCatalogSearchResult extends StoredCatalogSummary {
  readonly searchRank: number;
}

const loadHomeKind = async (
  database: CatalogTransaction,
  kind: "movie" | "show",
  sectionSize: number,
): Promise<readonly StoredCatalogSummary[]> => {
  const rows = await database
    .select(summarySelection)
    .from(canonicalItem)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(eq(canonicalItem.kind, kind))
    .orderBy(desc(libraryEntry.createdAt), asc(canonicalItem.id))
    .limit(sectionSize);
  return rows.map((row) => storedSummary(row));
};

const playableItemCondition = sql<boolean>`exists (
  select 1
  from ${mediaSource} as playable_source
  inner join ${providerInstance} as playable_provider
    on playable_provider.id = playable_source.provider_instance_id
  left join ${providerInstanceObservation} as playable_observation
    on playable_observation.provider_instance_id = playable_provider.id
  where playable_source.canonical_item_id = ${canonicalItem.id}
    and playable_source.availability = 'available'
    and playable_provider.enabled
    and playable_observation.status = 'healthy'
    and playable_observation.instance_revision = playable_provider.revision
)`;

const libraryCursorCondition = (cursor: CatalogLibraryCursor | undefined): SQL | undefined => {
  if (cursor === undefined) {
    return undefined;
  }
  switch (cursor.sort) {
    case "title": {
      return sql`(
        lower(${canonicalItem.title}) > ${cursor.normalizedTitle}
        or (
          lower(${canonicalItem.title}) = ${cursor.normalizedTitle}
          and ${canonicalItem.id} > ${cursor.id}::uuid
        )
      )`;
    }
    case "release_date": {
      const releaseDate = sql`coalesce(${canonicalItem.releaseDate}, ${canonicalItem.firstReleaseDate})`;
      if (cursor.releaseDate === null) {
        return sql`${releaseDate} is null and ${canonicalItem.id} > ${cursor.id}::uuid`;
      }
      return sql`(
        ${releaseDate} < ${cursor.releaseDate}::date
        or (${releaseDate} = ${cursor.releaseDate}::date and ${canonicalItem.id} > ${cursor.id}::uuid)
        or ${releaseDate} is null
      )`;
    }
    case "date_added": {
      return sql`(
        ${libraryEntry.createdAt} < ${cursor.createdAt}::timestamptz
        or (
          ${libraryEntry.createdAt} = ${cursor.createdAt}::timestamptz
          and ${canonicalItem.id} > ${cursor.id}::uuid
        )
      )`;
    }
    default: {
      return undefined;
    }
  }
};

const libraryFilterConditions = (input: CatalogLibraryQuery): SQL[] => {
  const conditions: SQL[] = [];
  if (input.kinds.length > EMPTY_LENGTH) {
    conditions.push(inArray(canonicalItem.kind, input.kinds));
  }
  if (input.genre !== undefined) {
    conditions.push(sql`${input.genre} = any(${canonicalItem.genres})`);
  }
  if (input.releaseYear !== undefined) {
    conditions.push(eq(canonicalItem.releaseYear, input.releaseYear));
  }
  if (input.playableOnly) {
    conditions.push(playableItemCondition);
  }
  return conditions;
};
const libraryConditions = (input: CatalogLibraryQuery): readonly SQL[] => {
  const conditions = libraryFilterConditions(input);
  const cursorCondition = libraryCursorCondition(input.cursor);
  if (cursorCondition !== undefined) {
    conditions.push(cursorCondition);
  }
  return conditions;
};
const loadLibrary = async (
  database: CatalogTransaction,
  input: CatalogLibraryQuery,
): Promise<readonly StoredCatalogSummary[]> => {
  const conditions = libraryConditions(input);
  const query = database
    .select(summarySelection)
    .from(canonicalItem)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(and(...conditions));
  switch (input.sort) {
    case "title": {
      const rows = await query
        .orderBy(sql`lower(${canonicalItem.title})`, asc(canonicalItem.id))
        .limit(input.limit);
      return rows.map((row) => storedSummary(row));
    }
    case "release_date": {
      const rows = await query
        .orderBy(
          sql`coalesce(${canonicalItem.releaseDate}, ${canonicalItem.firstReleaseDate}) desc nulls last`,
          asc(canonicalItem.id),
        )
        .limit(input.limit);
      return rows.map((row) => storedSummary(row));
    }
    case "date_added": {
      const rows = await query
        .orderBy(desc(libraryEntry.createdAt), asc(canonicalItem.id))
        .limit(input.limit);
      return rows.map((row) => storedSummary(row));
    }
    default: {
      throw new Error("catalog Library sort is invalid");
    }
  }
};

const prefixSearchQuery = (query: string) => sql`(
  select to_tsquery(
    'simple',
    string_agg(search_lexeme || ':*', ' & ' order by search_lexeme)
  )
  from unnest(tsvector_to_array(to_tsvector('simple', ${query}))) as search_lexeme
)`;

const loadSearch = async (
  database: CatalogTransaction,
  input: CatalogSearchQuery,
): Promise<readonly StoredCatalogSearchResult[]> => {
  const searchQuery = prefixSearchQuery(input.query);
  const searchRank = sql<number>`ts_rank(${canonicalItem.searchVector}, ${searchQuery})`;
  const conditions: SQL[] = [sql`${canonicalItem.searchVector} @@ ${searchQuery}`];
  if (input.kinds.length > EMPTY_LENGTH) {
    conditions.push(inArray(canonicalItem.kind, input.kinds));
  }
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${searchRank} < ${input.cursor.rank}::real
      or (
        ${searchRank} = ${input.cursor.rank}::real
        and lower(${canonicalItem.title}) > ${input.cursor.normalizedTitle}
      )
      or (
        ${searchRank} = ${input.cursor.rank}::real
        and lower(${canonicalItem.title}) = ${input.cursor.normalizedTitle}
        and ${canonicalItem.id} > ${input.cursor.id}::uuid
      )
    )`);
  }
  const rows = await database
    .select({ ...summarySelection, searchRank: searchRank.as("search_rank") })
    .from(canonicalItem)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(and(...conditions))
    .orderBy(desc(searchRank), sql`lower(${canonicalItem.title})`, asc(canonicalItem.id))
    .limit(input.limit);
  return rows.map((row) => Object.assign(storedSummary(row), { searchRank: row.searchRank }));
};

export { loadHomeKind, loadLibrary, loadSearch };
export type {
  CatalogLibraryCursor,
  CatalogLibraryQuery,
  CatalogLibrarySort,
  CatalogSearchCursor,
  CatalogSearchQuery,
  StoredCatalogSearchResult,
};
