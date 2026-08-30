import { Context, Effect, Layer, Redacted } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { ArtworkAccess } from "./catalog-artwork-access.ts";
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
      const artworkAccess = yield* ArtworkAccess;
      const query = yield* makeCatalogQuery({
        artworkAccess,
        catalog: database.catalogQueries,
        masterKey: Redacted.value(config.security.masterKey),
        now: Date.now,
      });
      return CatalogQuery.of(query);
    }),
  );
}

export { CatalogQuery };
