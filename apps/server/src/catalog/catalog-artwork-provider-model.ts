import type { ProviderArtworkLease } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { Effect } from "effect";

interface CatalogArtworkLeaseRequest {
  readonly artworkReference: string;
  readonly itemReference: string;
  readonly maxHeight: number;
  readonly maxWidth: number;
  readonly providerInstanceId: string;
  readonly revision: string;
}

interface CatalogArtworkLeaseResolution {
  readonly approvedOrigins: readonly string[];
  readonly lease: ProviderArtworkLease;
}

type CatalogArtworkLeaseResolver = (
  input: CatalogArtworkLeaseRequest,
) => Effect.Effect<CatalogArtworkLeaseResolution, unknown>;

export type {
  CatalogArtworkLeaseRequest,
  CatalogArtworkLeaseResolution,
  CatalogArtworkLeaseResolver,
};
