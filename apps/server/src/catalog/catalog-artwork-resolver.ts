import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { Effect } from "effect";

import type { Database } from "../database/database.ts";
import type { PluginSupervisorService } from "../plugin/model.ts";
import { bundledProviders } from "../provider/bundled-provider-registry.ts";
import type { BundledProvider } from "../provider/bundled-provider-registry.ts";
import type { ProviderManagement } from "../provider/provider-management.ts";
import { makeArtworkAssetLoader } from "./catalog-artwork-asset-fetch.ts";
import { normalizedLocatorOrigin } from "./catalog-artwork-origin.ts";
import type { CatalogArtworkLeaseRequest } from "./catalog-artwork-provider-model.ts";

const ARTWORK_DEADLINE_MILLISECONDS = 5000;

const loadArtworkLaunch = (
  database: Database["Service"],
  providerInstanceId: string,
  revision: string,
) =>
  Effect.gen(function* loadArtworkProvider() {
    const stored = yield* database.providers.loadInstance(providerInstanceId);
    if (!stored.enabled || stored.revision !== revision) {
      return yield* Effect.fail(new Error("provider instance revision is unavailable"));
    }
    const provider = bundledProviders.find(
      (candidate) => candidate.providerTypeId === stored.providerTypeId,
    );
    if (provider === undefined) {
      return yield* Effect.fail(new Error("provider type is unavailable"));
    }
    return { provider, stored };
  });
const approvedArtworkOrigins = (
  provider: BundledProvider,
  configuration: Readonly<Record<string, unknown>>,
): readonly string[] | undefined => {
  const origins = new Set<string>();
  for (const property of provider.locatorOriginConfigurationProperties) {
    const value = configuration[property];
    if (typeof value !== "string") {
      return undefined;
    }
    const origin = normalizedLocatorOrigin(value);
    if (origin === undefined) {
      return undefined;
    }
    origins.add(origin);
  }
  return [...origins];
};

const makeCatalogArtworkLeaseResolver =
  (database: Database["Service"], supervisor: PluginSupervisorService) =>
  (input: CatalogArtworkLeaseRequest) =>
    Effect.scoped(
      Effect.gen(function* resolveProviderArtwork() {
        const { provider, stored } = yield* loadArtworkLaunch(
          database,
          input.providerInstanceId,
          input.revision,
        );
        const plugin = yield* supervisor.supervise(provider.descriptor, {
          configuration: stored.configuration,
          credentials: stored.credentials,
          kind: "instance",
          providerInstanceId: stored.id,
          revision: stored.revision,
        });
        const response = yield* plugin.call(
          LibraryService.method.resolveArtwork,
          {
            artworkReference: {
              artworkId: input.artworkReference,
              itemReference: { itemId: input.itemReference },
            },
            maxHeight: input.maxHeight,
            maxWidth: input.maxWidth,
          },
          ARTWORK_DEADLINE_MILLISECONDS,
        );
        if (response.lease === undefined) {
          return yield* Effect.fail(new Error("provider artwork lease is missing"));
        }
        const approvedOrigins = approvedArtworkOrigins(provider, stored.configuration);
        if (approvedOrigins === undefined) {
          return yield* Effect.fail(new Error("provider artwork origins are unavailable"));
        }
        return { approvedOrigins, lease: response.lease };
      }),
    );

const makeCatalogArtworkAssetLoader = (
  database: Database["Service"],
  providerManagement: ProviderManagement["Service"],
  supervisor: PluginSupervisorService,
) =>
  makeArtworkAssetLoader(
    makeCatalogArtworkLeaseResolver(database, supervisor),
    providerManagement.runProviderActivity,
  );

export { makeCatalogArtworkAssetLoader, makeCatalogArtworkLeaseResolver };
