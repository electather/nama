import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { ProviderCapability as PluginProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect } from "effect";

import { ProviderCredentialsUnavailable as StoredProviderCredentialsUnavailable } from "../database/provider-persistence.ts";
import type {
  ProviderCredentialsFailure,
  ProviderPersistence,
  ProviderPersistenceFailure,
} from "../database/provider-persistence.ts";
import type { PluginSupervisorService } from "../plugin/model.ts";
import { bundledProviders } from "../provider/bundled-provider-registry.ts";
import {
  CatalogCapabilityIncompatible,
  CatalogCredentialsUnavailable,
  CatalogDatabaseUnavailable,
  CatalogProviderStale,
} from "./catalog-import-model.ts";
import type { CatalogScanRequest, ListCatalogPage } from "./catalog-import-model.ts";

const CATALOG_CALL_DEADLINE_MILLISECONDS = 30_000;

const catalogPersistenceAccessFailure = (
  failure: ProviderCredentialsFailure | ProviderPersistenceFailure,
):
  | InstanceType<typeof CatalogCredentialsUnavailable>
  | InstanceType<typeof CatalogDatabaseUnavailable> => {
  if (failure instanceof StoredProviderCredentialsUnavailable) {
    return new CatalogCredentialsUnavailable();
  }
  return new CatalogDatabaseUnavailable();
};

const pluginScanRequest = (scan: CatalogScanRequest) => {
  if (scan.case === "begin") {
    return { scan: { case: "begin" as const, value: { pageSize: scan.pageSize } } };
  }
  return { scan: { case: "continuation" as const, value: scan.value } };
};

const listProviderCatalogPage =
  (persistence: ProviderPersistence, supervisor: PluginSupervisorService): ListCatalogPage =>
  (provider, scan) =>
    Effect.gen(function* listExactProviderCatalogPage() {
      const stored = yield* persistence
        .loadInstance(provider.providerInstanceId)
        .pipe(Effect.mapError(catalogPersistenceAccessFailure));
      if (!stored.enabled || stored.revision !== provider.revision) {
        return yield* Effect.fail(new CatalogProviderStale());
      }
      const installation = yield* persistence
        .loadInstallation(stored.providerTypeId)
        .pipe(Effect.mapError(() => new CatalogDatabaseUnavailable()));
      const bundled = bundledProviders.find(
        (candidate) => candidate.providerTypeId === stored.providerTypeId,
      );
      if (
        installation === undefined ||
        bundled === undefined ||
        !installation.capabilities.includes(PluginProviderCapability.LIBRARY_READ)
      ) {
        return yield* Effect.fail(new CatalogCapabilityIncompatible());
      }
      const plugin = yield* supervisor.supervise(bundled.descriptor, {
        configuration: stored.configuration,
        credentials: stored.credentials,
        kind: "instance",
        providerInstanceId: stored.id,
        revision: stored.revision,
      });
      return yield* plugin.call(
        LibraryService.method.listItems,
        pluginScanRequest(scan),
        CATALOG_CALL_DEADLINE_MILLISECONDS,
      );
    });

export { listProviderCatalogPage };
