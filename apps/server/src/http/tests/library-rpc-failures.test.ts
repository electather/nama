import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { ErrorInfoSchema, RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { LibraryService, LibrarySort, WatchFilter } from "@nama/api/nama/api/v1/library_pb.js";
import { Effect } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import { CatalogQuery } from "../../catalog/catalog-query-live.ts";
import { CatalogNotReady, MediaStateUnavailable } from "../../catalog/catalog-query-model.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";

const authentication: AuthenticationService = Object.freeze({
  approveDeviceAuthorization: () => Effect.die("unexpected device authorization approval"),
  consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
  consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
  resolveAdministrator: () => Effect.die("unexpected administrator resolution"),
  resolveConsumerPrincipal: () => Effect.succeed({ id: "principal-1" }),
  resolvePrincipal: () => Effect.die("unexpected principal resolution"),
  revokeAppleClientRefreshTokens: Effect.die("unexpected Apple client revocation"),
  signIn: () => Effect.die("unexpected sign-in"),
  signOut: () => Effect.die("unexpected sign-out"),
});

const unusedCatalogQuery = CatalogQuery.of({
  getHome: () => Effect.die("unexpected catalog home read"),
  getMedia: () => Effect.die("unexpected catalog media read"),
  getMediaSource: () => Effect.die("unexpected catalog source read"),
  listChildren: () => Effect.die("unexpected catalog children list"),
  listLibrary: () => Effect.die("unexpected catalog library list"),
  resolveArtwork: () => Effect.die("unexpected catalog artwork resolution"),
  search: () => Effect.die("unexpected catalog search"),
});

const startLibraryClient = (catalogQuery: CatalogQuery["Service"]) =>
  Effect.gen(function* startLibraryFailureClient() {
    const server = yield* startServer(makeDatabase(Effect.succeed(true), "configured"), {
      authentication,
      catalogQuery,
    });
    return createClient(
      LibraryService,
      createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
    );
  });

const requestOptions = {
  headers: { authorization: "Bearer library-reader" },
} as const;

it.effect("maps catalog readiness retry guidance through real Connect", () =>
  Effect.scoped(
    Effect.gen(function* catalogReadinessFailureTest() {
      const client = yield* startLibraryClient(
        CatalogQuery.of({
          ...unusedCatalogQuery,
          getHome: () => Effect.fail(new CatalogNotReady({ retryDelayMilliseconds: 2500 })),
        }),
      );
      const failure = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () => client.getHome({}, requestOptions),
      }).pipe(Effect.flip);
      if (!(failure instanceof ConnectError)) {
        throw new TypeError("catalog readiness did not return a Connect error");
      }

      expect(failure.code).toBe(Code.Unavailable);
      expect(failure.findDetails(ErrorInfoSchema)).toMatchObject([
        { domain: "nama.api.v1", reason: "CATALOG_NOT_READY" },
      ]);
      expect(failure.findDetails(RetryInfoSchema)).toMatchObject([
        { retryDelay: { nanos: 500_000_000, seconds: 2n } },
      ]);
    }),
  ),
);

it.effect("maps unavailable media state through real Connect", () =>
  Effect.scoped(
    Effect.gen(function* mediaStateFailureTest() {
      const client = yield* startLibraryClient(
        CatalogQuery.of({
          ...unusedCatalogQuery,
          listLibrary: () => Effect.fail(new MediaStateUnavailable({})),
        }),
      );
      const failure = yield* Effect.tryPromise({
        catch: (error) => error,
        try: () =>
          client.listLibrary(
            {
              filter: { watchFilter: WatchFilter.WATCHED },
              sort: LibrarySort.TITLE_ASC,
            },
            requestOptions,
          ),
      }).pipe(Effect.flip);
      if (!(failure instanceof ConnectError)) {
        throw new TypeError("catalog media-state failure did not return a Connect error");
      }

      expect(failure.code).toBe(Code.FailedPrecondition);
      expect(failure.findDetails(ErrorInfoSchema)).toMatchObject([
        { domain: "nama.api.v1", reason: "MEDIA_STATE_UNAVAILABLE" },
      ]);
      expect(failure.findDetails(RetryInfoSchema)).toEqual([]);
    }),
  ),
);
