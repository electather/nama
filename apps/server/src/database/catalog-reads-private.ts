import { asc, eq, getTableColumns, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { canonicalArtwork, canonicalCredit } from "./catalog-artwork-schema.ts";
import { canonicalHierarchy, canonicalItem, libraryEntry } from "./catalog-item-schema.ts";
import type {
  CatalogDatabase,
  CatalogTransaction,
  StoredCatalogArtwork,
  StoredCatalogCredit,
  StoredCatalogItem,
  StoredCatalogMediaPart,
  StoredCatalogMediaSource,
  StoredCatalogMediaTrack,
  StoredCatalogParent,
} from "./catalog-persistence-model-private.ts";
import {
  availability,
  creditRole,
  mediaKind,
  storedArtwork,
  trackDetails,
} from "./catalog-read-model-private.ts";
import { mediaPart, mediaSource } from "./catalog-source-schema.ts";
import { mediaTrack } from "./catalog-track-schema.ts";

const EMPTY_LENGTH = 0;
const FIRST_ROW = 0;
const SINGLE_ROW_LIMIT = 1;

type CatalogItemRow = typeof canonicalItem.$inferSelect & {
  readonly libraryCreatedAt: Date | null;
};
interface CreditRow {
  readonly artwork: typeof canonicalArtwork.$inferSelect | null;
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
  readonly artwork: readonly (typeof canonicalArtwork.$inferSelect)[];
  readonly credits: readonly CreditRow[];
  readonly parents: readonly ParentRow[];
  readonly sources: readonly (typeof mediaSource.$inferSelect)[];
}
interface NestedRows {
  readonly parts: readonly (typeof mediaPart.$inferSelect)[];
  readonly tracks: readonly (typeof mediaTrack.$inferSelect)[];
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
    .select()
    .from(canonicalArtwork)
    .where(eq(canonicalArtwork.canonicalItemId, canonicalItemId))
    .orderBy(asc(canonicalArtwork.displayOrder));

const loadCreditRows = (database: CatalogTransaction, canonicalItemId: string) =>
  database
    .select({
      artwork: canonicalArtwork,
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
    .orderBy(asc(canonicalHierarchy.relationship));
};

const loadSourceRows = (database: CatalogTransaction, canonicalItemId: string) =>
  database
    .select()
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

const loadNestedRows = async (
  database: CatalogTransaction,
  sources: RelatedRows["sources"],
): Promise<NestedRows> => {
  let parts: readonly (typeof mediaPart.$inferSelect)[] = [];
  const sourceIds = sources.map((source) => source.id);
  if (sourceIds.length > EMPTY_LENGTH) {
    parts = await database
      .select()
      .from(mediaPart)
      .where(inArray(mediaPart.sourceId, sourceIds))
      .orderBy(asc(mediaPart.partOrder));
  }
  let tracks: readonly (typeof mediaTrack.$inferSelect)[] = [];
  const partIds = parts.map((part) => part.id);
  if (partIds.length > EMPTY_LENGTH) {
    tracks = await database
      .select()
      .from(mediaTrack)
      .where(inArray(mediaTrack.partId, partIds))
      .orderBy(asc(mediaTrack.trackOrder));
  }
  return { parts, tracks };
};

const creditPortraitArtwork = (
  activeArtwork: typeof canonicalArtwork.$inferSelect | null,
  artworkById: ReadonlyMap<string, StoredCatalogArtwork>,
): StoredCatalogArtwork | undefined => {
  if (!activeArtwork) {
    return undefined;
  }
  return artworkById.get(activeArtwork.id);
};

const storedCredits = (
  rows: RelatedRows["credits"],
  artwork: readonly StoredCatalogArtwork[],
): readonly StoredCatalogCredit[] => {
  const artworkById = new Map(artwork.map((entry) => [entry.id, entry]));
  return rows.map((credit) => {
    const portraitArtwork = creditPortraitArtwork(credit.artwork, artworkById);
    return {
      characterName: credit.characterName ?? undefined,
      name: credit.name,
      portraitArtwork,
      role: creditRole(credit.role),
    };
  });
};

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

const storedPart = (
  part: typeof mediaPart.$inferSelect,
  tracksByPart: ReadonlyMap<string, (typeof mediaTrack.$inferSelect)[]>,
): StoredCatalogMediaPart => ({
  bitRateBps: part.bitRateBps ?? undefined,
  container: part.container,
  id: part.id,
  order: part.partOrder,
  runtime: { nanoseconds: part.runtimeNanoseconds, seconds: part.runtimeSeconds },
  sizeBytes: part.sizeBytes ?? undefined,
  tracks: (tracksByPart.get(part.id) ?? []).map((track): StoredCatalogMediaTrack => ({
    details: trackDetails(track),
    id: track.id,
    order: track.trackOrder,
  })),
});

const storedPartsBySource = (nested: NestedRows): ReadonlyMap<string, StoredCatalogMediaPart[]> => {
  const tracksByPart = Map.groupBy(nested.tracks, (track) => track.partId);
  const partRowsBySource = Map.groupBy(nested.parts, (part) => part.sourceId);
  return new Map(
    [...partRowsBySource].map(([sourceId, parts]) => [
      sourceId,
      parts.map((part) => storedPart(part, tracksByPart)),
    ]),
  );
};

const storedSources = (
  rows: RelatedRows["sources"],
  nested: NestedRows,
): readonly StoredCatalogMediaSource[] => {
  const partsBySource = storedPartsBySource(nested);
  return rows.map((source) => ({
    availability: availability(source.availability),
    bitRateBps: source.bitRateBps ?? undefined,
    id: source.id,
    label: source.label ?? undefined,
    parts: partsBySource.get(source.id) ?? [],
    runtime: { nanoseconds: source.runtimeNanoseconds, seconds: source.runtimeSeconds },
  }));
};

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
  nested: NestedRows,
): StoredCatalogItem => {
  const artwork = related.artwork.map((row) => storedArtwork(row));
  return {
    ...storedKindDetails(item),
    ...storedMetadata(item),
    artwork,
    credits: storedCredits(related.credits, artwork),
    genres: item.genres,
    id: item.id,
    kind: mediaKind(item.kind),
    libraryCreatedAt: item.libraryCreatedAt ?? undefined,
    parents: storedParents(related.parents),
    runtime: { nanoseconds: item.runtimeNanoseconds, seconds: item.runtimeSeconds },
    sources: storedSources(related.sources, nested),
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
  const nested = await loadNestedRows(transaction, related.sources);
  return storedItem(item, related, nested);
};

const loadItem = (
  database: CatalogDatabase,
  canonicalItemId: string,
): Promise<StoredCatalogItem | undefined> =>
  database.transaction((transaction) => loadItemSnapshot(transaction, canonicalItemId), {
    accessMode: "read only",
    isolationLevel: "repeatable read",
  });

export { loadItem };
