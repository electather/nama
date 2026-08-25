import { eq } from "drizzle-orm";

import { canonicalArtwork } from "./catalog-artwork-schema.ts";
import { libraryEntry } from "./catalog-item-schema.ts";
import type { CatalogDatabase } from "./catalog-persistence-model-private.ts";

const FIRST_ROW_INDEX = 0;
const SINGLE_ROW_LIMIT = 1;

interface CatalogArtworkTarget {
  readonly artworkReference: string;
  readonly height: number | null;
  readonly itemReference: string;
  readonly providerInstanceId: string;
  readonly width: number | null;
}

const loadArtworkTarget = async (
  database: CatalogDatabase,
  artworkId: string,
): Promise<CatalogArtworkTarget | undefined> => {
  const rows = await database
    .select({
      artworkReference: canonicalArtwork.artworkReference,
      height: canonicalArtwork.height,
      itemReference: canonicalArtwork.itemReference,
      providerInstanceId: canonicalArtwork.providerInstanceId,
      width: canonicalArtwork.width,
    })
    .from(canonicalArtwork)
    .innerJoin(libraryEntry, eq(libraryEntry.canonicalItemId, canonicalArtwork.canonicalItemId))
    .where(eq(canonicalArtwork.id, artworkId))
    .limit(SINGLE_ROW_LIMIT);
  return rows.at(FIRST_ROW_INDEX);
};

export { loadArtworkTarget };
export type { CatalogArtworkTarget };
