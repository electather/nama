import { Effect } from "effect";

import type { CatalogPersistence } from "../catalog-persistence.ts";
import type { CatalogQueryStorage } from "../catalog-query-storage.ts";

const unusedCatalogPersistence: CatalogPersistence = Object.freeze({
  acceptPage: () => Effect.die("unexpected catalog page acceptance"),
  beginScan: () => Effect.die("unexpected catalog scan admission"),
  failScan: () => Effect.die("unexpected catalog scan failure"),
  listScanCandidates: Effect.die("unexpected catalog scan candidate read"),
  loadItem: () => Effect.die("unexpected canonical catalog read"),
  observeItem: () => Effect.die("unexpected canonical catalog observation"),
  pauseDisabledScans: () => Effect.die("unexpected disabled catalog scan reconciliation"),
  resolvePageAcceptance: () => Effect.die("unexpected catalog page resolution"),
  restartScan: () => Effect.die("unexpected catalog scan restart"),
});

const unusedCatalogQueries: CatalogQueryStorage = Object.freeze({
  getArtworkLocatorTarget: () => {
    throw new Error("unexpected canonical catalog query");
  },
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
