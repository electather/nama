import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { canonicalArtwork, canonicalCredit } from "./catalog-artwork-schema.ts";
import { canonicalHierarchy, canonicalItem, libraryEntry } from "./catalog-item-schema.ts";
import type { PartsBySource } from "./catalog-nested-reads-private.ts";
import { loadPartsBySource } from "./catalog-nested-reads-private.ts";
import type {
  CatalogDatabase,
  CatalogTransaction,
  StoredCatalogArtwork,
  StoredCatalogCredit,
  StoredCatalogItem,
  StoredCatalogMediaSource,
  StoredCatalogParent,
} from "./catalog-persistence-model-private.ts";
import type { ArtworkReadRow } from "./catalog-read-model-private.ts";
import {
  availability,
  creditRole,
  mediaKind,
  storedArtwork,
} from "./catalog-read-model-private.ts";
import { mediaSource } from "./catalog-source-schema.ts";

const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;

// oxlint-disable-next-line eslint/sort-keys -- Drizzle needs the non-nullable ID first to preserve left-joined artwork without dimensions.
const artworkSelection = {
  id: canonicalArtwork.id,
  height: canonicalArtwork.height,
  locale: canonicalArtwork.locale,
  role: canonicalArtwork.role,
  textPresence: canonicalArtwork.textPresence,
  width: canonicalArtwork.width,
};

type SourceRow = Pick<
  typeof mediaSource.$inferSelect,
  "availability" | "bitRateBps" | "id" | "label" | "runtimeNanoseconds" | "runtimeSeconds"
>;
type CatalogItemRow = typeof canonicalItem.$inferSelect & {
  readonly libraryCreatedAt: Date | null;
};
interface CreditRow {
  readonly artwork: ArtworkReadRow | null;
  readonly characterName: string | null;
  readonly displayOrder: number;
  readonly name: string;
  readonly role: string;
}
interface ParentRow {
  readonly id: string;
  readonly kind: string;
  readonly relationship: string;
  readonly title: string;
}
interface RelatedRows {
  readonly artwork: readonly ArtworkReadRow[];
  readonly credits: readonly CreditRow[];
  readonly parents: readonly ParentRow[];
  readonly sources: readonly SourceRow[];
}

const loadItemRow = async (
  database: CatalogTransaction,
  canonicalItemId: string,
): Promise<CatalogItemRow | undefined> => {
  const rows = await database
    .select({ ...getTableColumns(canonicalItem), libraryCreatedAt: libraryEntry.createdAt })
    .from(canonicalItem)
    .leftJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalItem.id))
    .where(eq(canonicalItem.id, canonicalItemId))
    .limit(SINGLE_ROW_LIMIT);
  return rows[FIRST_ROW];
};

const loadArtworkRows = (database: CatalogTransaction, canonicalItemId: string) =>
  database
    .select(artworkSelection)
    .from(canonicalArtwork)
    .where(
      and(
        eq(canonicalArtwork.canonicalItemId, canonicalItemId),
        eq(canonicalArtwork.targetItemReference, canonicalArtwork.itemReference),
      ),
    )
    .orderBy(asc(canonicalArtwork.displayOrder));

const loadCreditRows = (database: CatalogTransaction, canonicalItemId: string) =>
  database
    .select({
      artwork: artworkSelection,
      characterName: canonicalCredit.characterName,
      displayOrder: canonicalCredit.displayOrder,
      name: canonicalCredit.name,
      role: canonicalCredit.role,
    })
    .from(canonicalCredit)
    .leftJoin(canonicalArtwork, eq(canonicalArtwork.id, canonicalCredit.portraitArtworkId))
    .where(eq(canonicalCredit.canonicalItemId, canonicalItemId))
    .orderBy(asc(canonicalCredit.displayOrder));

const loadParentRows = (database: CatalogTransaction, canonicalItemId: string) => {
  const parentItem = alias(canonicalItem, "parent_item");
  return database
    .select({
      id: parentItem.id,
      kind: parentItem.kind,
      relationship: canonicalHierarchy.relationship,
      title: parentItem.title,
    })
    .from(canonicalHierarchy)
    .innerJoin(parentItem, eq(parentItem.id, canonicalHierarchy.parentItemId))
    .where(eq(canonicalHierarchy.childItemId, canonicalItemId))
    .orderBy(sql`case ${canonicalHierarchy.relationship} when 'show' then 1 else 2 end`);
};

const loadSourceRows = (database: CatalogTransaction, canonicalItemId: string) =>
  database
    .select({
      availability: mediaSource.availability,
      bitRateBps: mediaSource.bitRateBps,
      id: mediaSource.id,
      label: mediaSource.label,
      runtimeNanoseconds: mediaSource.runtimeNanoseconds,
      runtimeSeconds: mediaSource.runtimeSeconds,
    })
    .from(mediaSource)
    .where(eq(mediaSource.canonicalItemId, canonicalItemId))
    .orderBy(asc(mediaSource.sourceOrder));

const loadRelatedRows = async (
  database: CatalogTransaction,
  canonicalItemId: string,
): Promise<RelatedRows> => {
  const artwork = await loadArtworkRows(database, canonicalItemId);
  const credits = await loadCreditRows(database, canonicalItemId);
  const parents = await loadParentRows(database, canonicalItemId);
  const sources = await loadSourceRows(database, canonicalItemId);
  return { artwork, credits, parents, sources };
};

const storedCreditArtwork = (row: ArtworkReadRow | null): StoredCatalogArtwork | undefined => {
  if (row === null) {
    return undefined;
  }
  return storedArtwork(row);
};

const storedCredits = (rows: RelatedRows["credits"]): readonly StoredCatalogCredit[] =>
  rows.map((credit) => ({
    characterName: credit.characterName ?? undefined,
    name: credit.name,
    portraitArtwork: storedCreditArtwork(credit.artwork),
    role: creditRole(credit.role),
  }));

const storedParents = (rows: RelatedRows["parents"]): readonly StoredCatalogParent[] =>
  rows.map((parent) => {
    if (parent.relationship !== "season" && parent.relationship !== "show") {
      throw new Error("stored hierarchy relationship is invalid");
    }
    return {
      id: parent.id,
      kind: mediaKind(parent.kind),
      relationship: parent.relationship,
      title: parent.title,
    };
  });

const storedSources = (
  rows: RelatedRows["sources"],
  partsBySource: PartsBySource,
): readonly StoredCatalogMediaSource[] =>
  rows.map((source) => ({
    availability: availability(source.availability),
    bitRateBps: source.bitRateBps ?? undefined,
    id: source.id,
    label: source.label ?? undefined,
    parts: partsBySource.get(source.id) ?? [],
    runtime: { nanoseconds: source.runtimeNanoseconds, seconds: source.runtimeSeconds },
  }));

const storedMetadata = (item: CatalogItemRow) => ({
  contentRating: item.contentRating ?? undefined,
  originalTitle: item.originalTitle ?? undefined,
  releaseYear: item.releaseYear ?? undefined,
  synopsis: item.synopsis ?? undefined,
  tagline: item.tagline ?? undefined,
});

const storedKindDetails = (item: CatalogItemRow) => ({
  episodeCount: item.episodeCount ?? undefined,
  episodeNumber: item.episodeNumber ?? undefined,
  firstReleaseDate: item.firstReleaseDate ?? undefined,
  lastReleaseDate: item.lastReleaseDate ?? undefined,
  releaseDate: item.releaseDate ?? undefined,
  seasonCount: item.seasonCount ?? undefined,
  seasonNumber: item.seasonNumber ?? undefined,
});

const storedItem = (
  item: CatalogItemRow,
  related: RelatedRows,
  partsBySource: PartsBySource,
): StoredCatalogItem => {
  const artwork = related.artwork.map((row) => storedArtwork(row));
  return {
    ...storedKindDetails(item),
    ...storedMetadata(item),
    artwork,
    credits: storedCredits(related.credits),
    genres: item.genres,
    id: item.id,
    kind: mediaKind(item.kind),
    libraryCreatedAt: item.libraryCreatedAt ?? undefined,
    parents: storedParents(related.parents),
    runtime: { nanoseconds: item.runtimeNanoseconds, seconds: item.runtimeSeconds },
    sources: storedSources(related.sources, partsBySource),
    studios: item.studios,
    title: item.title,
  };
};

const loadItemSnapshot = async (
  transaction: CatalogTransaction,
  canonicalItemId: string,
): Promise<StoredCatalogItem | undefined> => {
  const item = await loadItemRow(transaction, canonicalItemId);
  if (item === undefined) {
    return undefined;
  }
  const related = await loadRelatedRows(transaction, canonicalItemId);
  const partsBySource = await loadPartsBySource(
    transaction,
    related.sources.map((source) => source.id),
  );
  return storedItem(item, related, partsBySource);
};

const loadItem = (
  database: CatalogDatabase,
  canonicalItemId: string,
): Promise<StoredCatalogItem | undefined> =>
  database.transaction((transaction) => loadItemSnapshot(transaction, canonicalItemId), {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });

export { loadItem, loadItemSnapshot };
