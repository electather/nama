import { Effect } from "effect";

import { replaceCanonicalItem } from "./catalog-mutations-private.ts";
import { catalogPersistenceFailure } from "./catalog-persistence-model-private.ts";
import type {
  CatalogDatabase,
  CatalogDuration,
  CatalogItemObservation,
  CatalogMediaSourceObservation,
} from "./catalog-persistence-model-private.ts";
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

export {
  type CatalogDuration,
  type CatalogItemObservation,
  type CatalogMediaSourceObservation,
  type CatalogPersistence,
  makeCatalogPersistence,
};
