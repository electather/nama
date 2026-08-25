import { Context, Effect, Layer, Redacted } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { PluginSupervisor } from "../plugin/supervisor.ts";
import { ProviderManagement } from "../provider/provider-management.ts";
import { makeCatalogArtworkLeaseResolver } from "./catalog-artwork-resolver.ts";
import type { CatalogQueryService } from "./catalog-query-model.ts";
import { makeCatalogQuery } from "./catalog-query.ts";

const contextService = Context.Service;

class CatalogQuery extends contextService<CatalogQuery, CatalogQueryService>()(
  "@nama/server/CatalogQuery",
) {
  static readonly layer = Layer.effect(
    CatalogQuery,
    Effect.gen(function* makeCatalogQueryService() {
      const config = yield* Config;
      const database = yield* Database;
      const providerManagement = yield* ProviderManagement;
      const supervisor = yield* PluginSupervisor;
      const query = yield* makeCatalogQuery({
        catalog: database.catalogQueries,
        masterKey: Redacted.value(config.security.masterKey),
        now: Date.now,
        resolveArtworkLease: makeCatalogArtworkLeaseResolver(
          database,
          providerManagement,
          supervisor,
        ),
      });
      return CatalogQuery.of(query);
    }),
  );
}

export { CatalogQuery };
