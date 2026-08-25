import { and, asc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { canonicalHierarchy, canonicalItem, libraryEntry } from "./catalog-item-schema.ts";
import type {
  CatalogDatabase,
  CatalogMediaKind,
  CatalogTransaction,
  StoredCatalogItem,
  StoredCatalogMediaSource,
} from "./catalog-persistence-model-private.ts";
import { availability, mediaKind } from "./catalog-read-model-private.ts";
import { loadItemSnapshot } from "./catalog-reads-private.ts";
import { mediaSource } from "./catalog-source-schema.ts";
import type { StoredCatalogSummary } from "./catalog-summary-model-private.ts";
import { storedSummary } from "./catalog-summary-read-model-private.ts";
import { summarySelection } from "./catalog-summary-selection-private.ts";
import { providerInstance, providerInstanceObservation } from "./provider-schema.ts";

const ABSENT_VALUE = undefined;
const FIRST_ROW_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;

interface CatalogChildrenCursor {
  readonly id: string;
  readonly position: number;
}

interface CatalogChildrenQuery {
  readonly cursor?: CatalogChildrenCursor;
  readonly limit: number;
  readonly parentMediaId: string;
}

interface CatalogChildrenPage {
  readonly children: readonly StoredCatalogSummary[];
  readonly parentKind?: CatalogMediaKind;
}

interface EffectiveSourceRow {
  readonly availability: string;
  readonly id: string;
}

const effectiveSource = (
  row: EffectiveSourceRow,
  sourceById: ReadonlyMap<string, StoredCatalogMediaSource>,
): StoredCatalogMediaSource => {
  const source = sourceById.get(row.id);
  if (source === undefined) {
    throw new Error("catalog source projection is missing");
  }
  return { ...source, availability: availability(row.availability) };
};

const loadEffectiveItemSources = async (
  transaction: CatalogTransaction,
  item: StoredCatalogItem,
): Promise<StoredCatalogItem> => {
  const sourceRows = await transaction
    .select({
      availability: sql<string>`case
        when ${mediaSource.availability} = 'unsupported' then 'unsupported'
        when ${mediaSource.availability} = 'provider_unavailable' then 'provider_unavailable'
        when ${providerInstance.enabled}
          and ${providerInstanceObservation.status} = 'healthy'
          and ${providerInstanceObservation.instanceRevision} = ${providerInstance.revision}
          then 'available'
        else 'provider_unavailable'
      end`,
      id: mediaSource.id,
    })
    .from(mediaSource)
    .innerJoin(providerInstance, eq(providerInstance.id, mediaSource.providerInstanceId))
    .leftJoin(
      providerInstanceObservation,
      eq(providerInstanceObservation.providerInstanceId, providerInstance.id),
    )
    .where(eq(mediaSource.canonicalItemId, item.id))
    .orderBy(asc(providerInstance.syncPriority), asc(mediaSource.sourceOrder), asc(mediaSource.id));
  const sourceById = new Map(item.sources.map((source) => [source.id, source]));
  const sources = sourceRows.map((row) => effectiveSource(row, sourceById));
  return { ...item, sources };
};

const loadVisibleItem = (
  database: CatalogDatabase,
  canonicalItemId: string,
): Promise<StoredCatalogItem | undefined> =>
  database.transaction(
    async (transaction) => {
      const item = await loadItemSnapshot(transaction, canonicalItemId);
      if (item === undefined || item.libraryCreatedAt === undefined) {
        return ABSENT_VALUE;
      }
      return loadEffectiveItemSources(transaction, item);
    },
    { accessMode: "read only", isolationLevel: "repeatable read" },
  );

const loadVisibleParentKind = async (
  transaction: CatalogTransaction,
  parentMediaId: string,
): Promise<CatalogMediaKind | undefined> => {
  const rows = await transaction
    .select({ kind: canonicalItem.kind })
    .from(canonicalItem)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(eq(canonicalItem.id, parentMediaId))
    .limit(SINGLE_ROW_LIMIT);
  const row = rows.at(FIRST_ROW_INDEX);
  if (row === undefined) {
    return ABSENT_VALUE;
  }
  return mediaKind(row.kind);
};

const childProjection = (parentKind: "season" | "show") => {
  if (parentKind === "show") {
    return {
      childKind: "season" as const,
      positionColumn: canonicalItem.seasonNumber,
      relationship: "show" as const,
    };
  }
  return {
    childKind: "episode" as const,
    positionColumn: canonicalItem.episodeNumber,
    relationship: "season" as const,
  };
};

const childConditions = (
  input: CatalogChildrenQuery,
  parentKind: "season" | "show",
): readonly SQL[] => {
  const projection = childProjection(parentKind);
  const conditions: SQL[] = [
    eq(canonicalHierarchy.parentItemId, input.parentMediaId),
    eq(canonicalHierarchy.relationship, projection.relationship),
    eq(canonicalItem.kind, projection.childKind),
  ];
  if (input.cursor !== undefined) {
    conditions.push(sql`(
      ${projection.positionColumn} > ${input.cursor.position}
      or (
        ${projection.positionColumn} = ${input.cursor.position}
        and ${canonicalItem.id} > ${input.cursor.id}::uuid
      )
    )`);
  }
  return conditions;
};

const loadChildrenPage = async (
  transaction: CatalogTransaction,
  input: CatalogChildrenQuery,
): Promise<CatalogChildrenPage> => {
  const parentKind = await loadVisibleParentKind(transaction, input.parentMediaId);
  if (parentKind === undefined) {
    return { children: [] };
  }
  if (parentKind !== "show" && parentKind !== "season") {
    return { children: [], parentKind };
  }
  const projection = childProjection(parentKind);
  const rows = await transaction
    .select(summarySelection)
    .from(canonicalHierarchy)
    .innerJoin(canonicalItem, eq(canonicalItem.id, canonicalHierarchy.childItemId))
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(and(...childConditions(input, parentKind)))
    .orderBy(asc(projection.positionColumn), asc(canonicalItem.id))
    .limit(input.limit);
  return { children: rows.map((row) => storedSummary(row)), parentKind };
};

export { loadChildrenPage, loadVisibleItem };
export type { CatalogChildrenCursor, CatalogChildrenPage, CatalogChildrenQuery };
