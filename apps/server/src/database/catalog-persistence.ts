import { Effect } from "effect";

import { replaceCanonicalItem } from "./catalog-mutations-private.ts";
import { catalogPersistenceFailure } from "./catalog-persistence-model-private.ts";
import type {
  CatalogDatabase,
  CatalogItemObservation,
} from "./catalog-persistence-model-private.ts";
import { makeCatalogQueryStorage } from "./catalog-query-storage.ts";
import type { CatalogQueryStorage } from "./catalog-query-storage.ts";
import { loadItem } from "./catalog-reads-private.ts";

const makeCatalogPersistence = (database: CatalogDatabase) => ({
  loadItem: (canonicalItemId: string) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: () => loadItem(database, canonicalItemId),
    }),
  observeItem: (input: CatalogItemObservation) =>
    Effect.tryPromise({
      catch: catalogPersistenceFailure,
      try: async () => {
        const canonicalItemId = await replaceCanonicalItem(database, input);
        const stored = await loadItem(database, canonicalItemId);
        if (stored === undefined) {
          throw new Error("committed canonical catalog item is missing");
        }
        return stored;
      },
    }),
});
type CatalogPersistence = ReturnType<typeof makeCatalogPersistence>;

interface CatalogOwner {
  readonly persistence: CatalogPersistence;
  readonly queries: CatalogQueryStorage;
}

const makeCatalog = (database: CatalogDatabase): CatalogOwner => ({
  persistence: makeCatalogPersistence(database),
  queries: makeCatalogQueryStorage(database),
});

export {
  type CatalogItemObservation,
  type CatalogOwner,
  type CatalogPersistence,
  type CatalogQueryStorage,
  makeCatalog,
};
