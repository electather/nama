import { and, eq, isNotNull } from "drizzle-orm";

import { canonicalArtwork } from "./catalog-artwork-schema.ts";
import { libraryEntry } from "./catalog-item-schema.ts";
import type { CatalogDatabase } from "./catalog-persistence-model-private.ts";

const FIRST_ROW_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;

interface CatalogArtworkTarget {
  readonly assetBytes: Buffer | null;
  readonly assetMimeType: string | null;
  readonly height: number | null;
  readonly width: number | null;
}

interface CatalogArtworkLocatorTarget {
  readonly height: number | null;
  readonly width: number | null;
}

const loadArtworkTarget = async (
  database: CatalogDatabase,
  artworkId: string,
): Promise<CatalogArtworkTarget | undefined> => {
  const rows = await database
    .select({
      assetBytes: canonicalArtwork.assetBytes,
      assetMimeType: canonicalArtwork.assetMimeType,
      height: canonicalArtwork.height,
      width: canonicalArtwork.width,
    })
    .from(canonicalArtwork)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalArtwork.canonicalItemId))
    .where(eq(canonicalArtwork.id, artworkId))
    .limit(SINGLE_ROW_LIMIT);
  return rows.at(FIRST_ROW_INDEX);
};

const loadArtworkLocatorTarget = async (
  database: CatalogDatabase,
  artworkId: string,
): Promise<CatalogArtworkLocatorTarget | undefined> => {
  const rows = await database
    .select({
      height: canonicalArtwork.height,
      width: canonicalArtwork.width,
    })
    .from(canonicalArtwork)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalArtwork.canonicalItemId))
    .where(
      and(
        eq(canonicalArtwork.id, artworkId),
        isNotNull(canonicalArtwork.assetBytes),
        isNotNull(canonicalArtwork.assetMimeType),
      ),
    )
    .limit(SINGLE_ROW_LIMIT);
  return rows.at(FIRST_ROW_INDEX);
};

export { loadArtworkLocatorTarget, loadArtworkTarget };
export type { CatalogArtworkLocatorTarget, CatalogArtworkTarget };
