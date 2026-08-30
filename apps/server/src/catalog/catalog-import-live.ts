import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

import { Database } from "../database/database.ts";
import { PluginSupervisor } from "../plugin/supervisor.ts";
import { ProviderActivity } from "../provider/provider-activity.ts";
import { ProviderManagement } from "../provider/provider-management.ts";
import { makeCatalogArtworkAssetLoader } from "./catalog-artwork-resolver.ts";
import type { CatalogImportService } from "./catalog-import-model.ts";
import { makeCatalogImport } from "./catalog-import.ts";
import { listProviderCatalogPage } from "./catalog-provider-access.ts";

const contextService = Context.Service;

class CatalogImport extends contextService<CatalogImport, CatalogImportService>()(
  "@nama/server/CatalogImport",
) {
  static readonly layer = Layer.effect(
    CatalogImport,
    Effect.gen(function* makeCatalogImportService() {
      const supervisor = yield* PluginSupervisor;
      const database = yield* Database;
      const providerManagement = yield* ProviderManagement;
      const activity = yield* ProviderActivity;
      const loadArtworkAsset = makeCatalogArtworkAssetLoader(
        database,
        providerManagement,
        supervisor,
      );
      return CatalogImport.of(
        makeCatalogImport({
          catalog: database.catalog,
          coreRunId: randomUUID(),
          listPage: listProviderCatalogPage(database.providers, supervisor),
          loadArtworkAsset,
          now: Date.now,
          random: Math.random,
          runProviderActivity: activity.run,
        }),
      );
    }),
  );
}

export { CatalogImport };
