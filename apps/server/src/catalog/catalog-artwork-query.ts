import { create } from "@bufbuild/protobuf";
import { Effect } from "effect";

import { ResolveArtworkResponseSchema } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import { CatalogQueryPersistenceError, ResourceNotFound } from "./catalog-query-model.ts";
import type { CatalogQueryDependencies, CatalogQueryService } from "./catalog-query-model.ts";
import { ensureCatalogReady } from "./catalog-readiness.ts";

const makeResolveArtwork =
  (dependencies: CatalogQueryDependencies): CatalogQueryService["resolveArtwork"] =>
  (_principalId, request) =>
    Effect.gen(function* resolveStoredArtwork() {
      const now = dependencies.now();
      yield* ensureCatalogReady(dependencies, now);
      const target = yield* Effect.tryPromise({
        catch: () => new CatalogQueryPersistenceError({}),
        try: () => dependencies.catalog.getArtworkLocatorTarget(request.artworkId),
      });
      if (target === undefined) {
        return yield* Effect.fail(new ResourceNotFound({}));
      }
      const locator = dependencies.artworkAccess.locator({
        artworkId: request.artworkId,
        height: target.height ?? undefined,
        now,
        width: target.width ?? undefined,
      });
      return create(ResolveArtworkResponseSchema, { locator });
    });

export { makeResolveArtwork };
