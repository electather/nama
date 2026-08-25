import { Effect } from "effect";

import { CatalogNotReady, CatalogQueryPersistenceError } from "./catalog-query-model.ts";
import type { CatalogQueryDependencies, CatalogReadFailure } from "./catalog-query-model.ts";

const DEFAULT_CATALOG_RETRY_MILLISECONDS = 5000;
const MINIMUM_CATALOG_RETRY_MILLISECONDS = 1000;
const MAXIMUM_CATALOG_RETRY_MILLISECONDS = 300_000;

const ensureCatalogReady = (
  dependencies: CatalogQueryDependencies,
  now: number,
): Effect.Effect<void, CatalogReadFailure> =>
  Effect.tryPromise({
    catch: () => new CatalogQueryPersistenceError({}),
    try: () => dependencies.catalog.loadReadiness(),
  }).pipe(
    Effect.flatMap((readiness) => {
      if (!readiness.hasEnabledProvider || readiness.hasCompletedImport) {
        return Effect.void;
      }
      let requestedDelay = DEFAULT_CATALOG_RETRY_MILLISECONDS;
      if (readiness.nextRetryAt !== undefined) {
        requestedDelay = readiness.nextRetryAt.getTime() - now;
      }
      const retryDelayMilliseconds = Math.min(
        MAXIMUM_CATALOG_RETRY_MILLISECONDS,
        Math.max(MINIMUM_CATALOG_RETRY_MILLISECONDS, requestedDelay),
      );
      return Effect.fail(new CatalogNotReady({ retryDelayMilliseconds }));
    }),
  );

export { ensureCatalogReady };
