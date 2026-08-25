import { Effect } from "effect";

import type { CatalogPersistence } from "../catalog-persistence.ts";
import type { CatalogQueryStorage } from "../catalog-query-storage.ts";

const unusedCatalogPersistence: CatalogPersistence = Object.freeze({
  loadItem: () => Effect.die("unexpected canonical catalog read"),
  observeItem: () => Effect.die("unexpected canonical catalog observation"),
});

const unusedCatalogQueries: CatalogQueryStorage = Object.freeze({
  getArtworkTarget: () => {
    throw new Error("unexpected canonical catalog query");
  },
  getItem: () => {
    throw new Error("unexpected canonical catalog query");
  },
  listChildren: () => {
    throw new Error("unexpected canonical catalog query");
  },
  listLibrary: () => {
    throw new Error("unexpected canonical catalog query");
  },
  loadHome: () => {
    throw new Error("unexpected canonical catalog query");
  },
  loadReadiness: () => {
    throw new Error("unexpected canonical catalog query");
  },
  search: () => {
    throw new Error("unexpected canonical catalog query");
  },
});

const unusedCatalog = Object.freeze({
  persistence: unusedCatalogPersistence,
  queries: unusedCatalogQueries,
});

export { unusedCatalog, unusedCatalogPersistence, unusedCatalogQueries };
