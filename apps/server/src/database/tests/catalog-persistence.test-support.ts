import { Effect } from "effect";

import type { CatalogPersistence } from "../catalog-persistence.ts";

const unusedCatalogPersistence: CatalogPersistence = Object.freeze({
  acceptPage: () => Effect.die("unexpected catalog page acceptance"),
  beginScan: () => Effect.die("unexpected catalog scan admission"),
  failScan: () => Effect.die("unexpected catalog scan failure"),
  freshness: Effect.die("unexpected catalog freshness read"),
  listScanCandidates: Effect.die("unexpected catalog scan candidate read"),
  loadItem: () => Effect.die("unexpected canonical catalog read"),
  observeItem: () => Effect.die("unexpected canonical catalog observation"),
  pauseDisabledScans: () => Effect.die("unexpected disabled catalog scan reconciliation"),
  resolvePageAcceptance: () => Effect.die("unexpected catalog page resolution"),
  restartScan: () => Effect.die("unexpected catalog scan restart"),
});

export { unusedCatalogPersistence };
