import { loadArtworkTarget } from "./catalog-artwork-query-private.ts";
import type { CatalogArtworkTarget } from "./catalog-artwork-query-private.ts";
import { loadChildrenPage, loadVisibleItem } from "./catalog-item-query-private.ts";
import type {
  CatalogChildrenCursor,
  CatalogChildrenPage,
  CatalogChildrenQuery,
} from "./catalog-item-query-private.ts";
import { loadHomeKind, loadLibrary, loadSearch } from "./catalog-list-query-private.ts";
import type {
  CatalogLibraryCursor,
  CatalogLibraryQuery,
  CatalogSearchCursor,
  CatalogSearchQuery,
  StoredCatalogSearchResult,
} from "./catalog-list-query-private.ts";
import type { CatalogDatabase, StoredCatalogItem } from "./catalog-persistence-model-private.ts";
import { loadReadiness } from "./catalog-readiness-private.ts";
import type { CatalogReadiness } from "./catalog-readiness-private.ts";
import type { StoredCatalogSummary } from "./catalog-summary-model-private.ts";

interface CatalogQueryStorage {
  readonly getArtworkTarget: (artworkId: string) => Promise<CatalogArtworkTarget | undefined>;
  readonly getItem: (canonicalItemId: string) => Promise<StoredCatalogItem | undefined>;
  readonly listChildren: (input: CatalogChildrenQuery) => Promise<CatalogChildrenPage>;
  readonly listLibrary: (input: CatalogLibraryQuery) => Promise<readonly StoredCatalogSummary[]>;
  readonly loadHome: (sectionSize: number) => Promise<
    Readonly<{
      readonly movies: readonly StoredCatalogSummary[];
      readonly shows: readonly StoredCatalogSummary[];
    }>
  >;
  readonly loadReadiness: () => Promise<CatalogReadiness>;
  readonly search: (input: CatalogSearchQuery) => Promise<readonly StoredCatalogSearchResult[]>;
}

const makeCatalogQueryStorage = (database: CatalogDatabase): CatalogQueryStorage => ({
  getArtworkTarget: (artworkId) => loadArtworkTarget(database, artworkId),
  getItem: (canonicalItemId) => loadVisibleItem(database, canonicalItemId),
  listChildren: (input) =>
    database.transaction((transaction) => loadChildrenPage(transaction, input), {
      accessMode: "read only",
      isolationLevel: "repeatable read",
    }),
  listLibrary: (input) =>
    database.transaction((transaction) => loadLibrary(transaction, input), {
      accessMode: "read only",
      isolationLevel: "repeatable read",
    }),
  loadHome: (sectionSize) =>
    database.transaction(
      async (transaction) => ({
        movies: await loadHomeKind(transaction, "movie", sectionSize),
        shows: await loadHomeKind(transaction, "show", sectionSize),
      }),
      { accessMode: "read only", isolationLevel: "repeatable read" },
    ),
  loadReadiness: () => loadReadiness(database),
  search: (input) =>
    database.transaction((transaction) => loadSearch(transaction, input), {
      accessMode: "read only",
      isolationLevel: "repeatable read",
    }),
});

export { makeCatalogQueryStorage };
export type {
  CatalogArtworkTarget,
  CatalogChildrenCursor,
  CatalogChildrenPage,
  CatalogChildrenQuery,
  CatalogLibraryCursor,
  CatalogLibraryQuery,
  CatalogQueryStorage,
  CatalogReadiness,
  CatalogSearchCursor,
  CatalogSearchQuery,
  StoredCatalogSearchResult,
  StoredCatalogSummary,
};
