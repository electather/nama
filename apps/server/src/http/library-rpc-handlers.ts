import type { ConnectRouter, HandlerContext, ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";

import { LibraryService } from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { CatalogQuery } from "../catalog/catalog-query-live.ts";
import { getRequestPrincipal } from "./request-pipeline.ts";
import type { RequestRuntime } from "./request-runtime.ts";

type LibraryServiceHandlerDependencies = Readonly<{
  readonly catalogQuery: CatalogQuery["Service"];
  readonly requestRuntime: RequestRuntime;
}>;

const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect" as const,
});

const makeCatalogRequestRunner =
  (requestRuntime: RequestRuntime) =>
  <Request, Success, Failure>(
    catalogRequest: (principalId: string, request: Request) => Effect.Effect<Success, Failure>,
    request: Request,
    context: HandlerContext,
  ): Promise<Success> => {
    const principal = getRequestPrincipal(context.values);
    if (principal === undefined) {
      return requestRuntime.runPromise(Effect.fail(privateAuthenticationDefect), context.signal);
    }
    return requestRuntime.runPromise(catalogRequest(principal.id, request), context.signal);
  };

const createLibraryServiceHandlers = ({
  catalogQuery,
  requestRuntime,
}: LibraryServiceHandlerDependencies): Partial<ServiceImpl<typeof LibraryService>> => {
  const runCatalogRequest = makeCatalogRequestRunner(requestRuntime);
  return {
    getHome: (request, context) => runCatalogRequest(catalogQuery.getHome, request, context),
    getMedia: (request, context) => runCatalogRequest(catalogQuery.getMedia, request, context),
    getMediaSource: (request, context) =>
      runCatalogRequest(catalogQuery.getMediaSource, request, context),
    listChildren: (request, context) =>
      runCatalogRequest(catalogQuery.listChildren, request, context),
    listLibrary: (request, context) =>
      runCatalogRequest(catalogQuery.listLibrary, request, context),
    resolveArtwork: (request, context) =>
      runCatalogRequest(catalogQuery.resolveArtwork, request, context),
    search: (request, context) => runCatalogRequest(catalogQuery.search, request, context),
  };
};

const registerLibraryConnectRoutes = (
  router: ConnectRouter,
  dependencies: LibraryServiceHandlerDependencies,
): void => {
  router.service(LibraryService, createLibraryServiceHandlers(dependencies));
};

export { registerLibraryConnectRoutes };
export type { LibraryServiceHandlerDependencies };
