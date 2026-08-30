import type { ListItemsResponse } from "@nama/api/nama/plugin/v1/library_pb.js";
import { Data } from "effect";
import type { Effect, Scope } from "effect";

import type { CatalogPersistence, CatalogScanLease } from "../database/catalog-persistence.ts";
import type { PluginCallFailure } from "../plugin/model.ts";
import type { ProviderActivityAdmission } from "../provider/provider-activity.ts";
import type { LoadArtworkAsset } from "./catalog-artwork-asset-fetch.ts";

const taggedError = Data.TaggedError;
const CatalogCapabilityIncompatible = taggedError("CatalogCapabilityIncompatible")<
  Readonly<Record<never, never>>
>;
const CatalogDatabaseUnavailable = taggedError("CatalogDatabaseUnavailable")<
  Readonly<Record<never, never>>
>;
const CatalogCredentialsUnavailable = taggedError("CatalogCredentialsUnavailable")<
  Readonly<Record<never, never>>
>;
const CatalogProviderStale = taggedError("CatalogProviderStale")<Readonly<Record<never, never>>>;

type CatalogProviderAccessFailure =
  | InstanceType<typeof CatalogCapabilityIncompatible>
  | InstanceType<typeof CatalogDatabaseUnavailable>
  | InstanceType<typeof CatalogCredentialsUnavailable>
  | InstanceType<typeof CatalogProviderStale>
  | PluginCallFailure;

type CatalogScanRequest =
  | Readonly<{ readonly case: "begin"; readonly pageSize: number }>
  | Readonly<{ readonly case: "continuation"; readonly value: string }>;

type ListCatalogPage = (
  provider: CatalogScanLease,
  scan: CatalogScanRequest,
) => Effect.Effect<ListItemsResponse, CatalogProviderAccessFailure, Scope.Scope>;

interface CatalogImportDependencies {
  readonly catalog: CatalogPersistence;
  readonly coreRunId: string;
  readonly loadArtworkAsset: LoadArtworkAsset;
  readonly now: () => number;
  readonly listPage: ListCatalogPage;
  readonly random: () => number;
  readonly runProviderActivity: ProviderActivityAdmission["run"];
}
type ReportCatalogFatalFailure = (cause: unknown) => Effect.Effect<boolean>;

interface CatalogImportService {
  readonly start: (
    reportFatalFailure: ReportCatalogFatalFailure,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

export {
  CatalogCapabilityIncompatible,
  CatalogCredentialsUnavailable,
  CatalogDatabaseUnavailable,
  CatalogProviderStale,
};
export type {
  CatalogImportDependencies,
  CatalogImportService,
  CatalogProviderAccessFailure,
  CatalogScanRequest,
  ReportCatalogFatalFailure,
  ListCatalogPage,
};
