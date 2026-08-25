import { Effect } from "effect";

import type { CatalogPersistence } from "../catalog-persistence.ts";

const unusedCatalogPersistence: CatalogPersistence = Object.freeze({
  loadItem: () => Effect.die("unexpected canonical catalog read"),
  observeItem: () => Effect.die("unexpected canonical catalog observation"),
});

export { unusedCatalogPersistence };
