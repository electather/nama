import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import {
  GetHomeResponseSchema,
  GetMediaResponseSchema,
  GetMediaSourceResponseSchema,
  HomeSectionKind,
  LibraryService,
  LibrarySort,
  ListChildrenResponseSchema,
  ListLibraryResponseSchema,
  ResolveArtworkResponseSchema,
  SearchResponseSchema,
  WatchFilter,
} from "@nama/api/nama/api/v1/library_pb.js";
import { MediaKind, Playability, SourceAvailability } from "@nama/api/nama/api/v1/media_pb.js";
import { Effect } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import { CatalogQuery } from "../../catalog/catalog-query-live.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";

const PRINCIPAL_ID = "principal-1";
const ARTWORK_REFRESH_AT = Object.freeze({ nanos: 0, seconds: 1_787_684_400n });
const ARTWORK_RESPONSE = create(ResolveArtworkResponseSchema, {
  locator: {
    allowedRedirectOrigins: ["https://media.example.test"],
    headers: [],
    refreshAt: ARTWORK_REFRESH_AT,
    url: "https://media.example.test/artwork",
  },
});

const authentication: AuthenticationService = Object.freeze({
  approveDeviceAuthorization: () => Effect.die("unexpected device authorization approval"),
  consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
  consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
  resolveAdministrator: () => Effect.die("unexpected administrator resolution"),
  resolveConsumerPrincipal: () => Effect.succeed({ id: PRINCIPAL_ID }),
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
  Effect.gen(function* startStoredLibraryClient() {
    const server = yield* startServer(makeDatabase(Effect.succeed(true), "configured"), {
      authentication,
      catalogQuery,
    });
    return createClient(
      LibraryService,
      createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
    );
  });

it.effect("serves GetHome through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* libraryGetHomeHandlerTest() {
      const received: { principalId?: string; sectionSize: number | undefined } = {
        sectionSize: undefined,
      };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        getHome: (principalId, request) => {
          received.principalId = principalId;
          received.sectionSize = request.sectionSize;
          return Effect.succeed(
            create(GetHomeResponseSchema, {
              sections: [
                {
                  id: "movies",
                  items: [],
                  kind: HomeSectionKind.MOVIES,
                  title: "Movies",
                },
              ],
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.getHome({ sectionSize: 7 }, { headers: { authorization: "Bearer library-reader" } }),
      );

      expect(received).toEqual({ principalId: PRINCIPAL_ID, sectionSize: 7 });
      expect(response.sections).toEqual([
        expect.objectContaining({
          id: "movies",
          items: [],
          kind: HomeSectionKind.MOVIES,
          title: "Movies",
        }),
      ]);
    }),
  ),
);

it.effect("serves ListLibrary through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* libraryListHandlerTest() {
      const received = {
        pageSize: 0,
        pageToken: "",
        principalId: "",
        sort: LibrarySort.UNSPECIFIED,
        watchFilter: WatchFilter.UNSPECIFIED,
      };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        listLibrary: (principalId, request) => {
          received.pageSize = request.pageSize;
          received.pageToken = request.pageToken;
          received.principalId = principalId;
          received.sort = request.sort;
          received.watchFilter = request.filter?.watchFilter ?? WatchFilter.UNSPECIFIED;
          return Effect.succeed(
            create(ListLibraryResponseSchema, {
              items: [],
              nextPageToken: "next-library-page",
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.listLibrary(
          {
            filter: { watchFilter: WatchFilter.ANY },
            pageSize: 3,
            pageToken: "library-page",
            sort: LibrarySort.TITLE_ASC,
          },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({
        pageSize: 3,
        pageToken: "library-page",
        principalId: PRINCIPAL_ID,
        sort: LibrarySort.TITLE_ASC,
        watchFilter: WatchFilter.ANY,
      });
      expect(response.nextPageToken).toBe("next-library-page");
    }),
  ),
);

it.effect("serves Search through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* librarySearchHandlerTest() {
      const received = { pageSize: 0, pageToken: "", principalId: "", query: "" };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        search: (principalId, request) => {
          received.pageSize = request.pageSize;
          received.pageToken = request.pageToken;
          received.principalId = principalId;
          received.query = request.query;
          return Effect.succeed(
            create(SearchResponseSchema, {
              items: [],
              nextPageToken: "next-search-page",
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.search(
          { pageSize: 4, pageToken: "search-page", query: "star" },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({
        pageSize: 4,
        pageToken: "search-page",
        principalId: PRINCIPAL_ID,
        query: "star",
      });
      expect(response.nextPageToken).toBe("next-search-page");
    }),
  ),
);

it.effect("serves GetMedia through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* libraryGetMediaHandlerTest() {
      const received = { mediaId: "", principalId: "" };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        getMedia: (principalId, request) => {
          received.mediaId = request.mediaId;
          received.principalId = principalId;
          return Effect.succeed(
            create(GetMediaResponseSchema, {
              media: {
                kindDetails: { case: "movie", value: {} },
                summary: {
                  id: "media-1",
                  kind: MediaKind.MOVIE,
                  playability: Playability.PLAYABLE,
                  title: "Stored Movie",
                },
              },
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.getMedia(
          { mediaId: "media-1" },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({ mediaId: "media-1", principalId: PRINCIPAL_ID });
      expect(response.media?.summary).toMatchObject({
        id: "media-1",
        kind: MediaKind.MOVIE,
        playability: Playability.PLAYABLE,
        title: "Stored Movie",
      });
    }),
  ),
);

it.effect("serves ListChildren through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* libraryChildrenHandlerTest() {
      const received = { pageSize: 0, pageToken: "", parentMediaId: "", principalId: "" };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        listChildren: (principalId, request) => {
          received.pageSize = request.pageSize;
          received.pageToken = request.pageToken;
          received.parentMediaId = request.parentMediaId;
          received.principalId = principalId;
          return Effect.succeed(
            create(ListChildrenResponseSchema, {
              items: [
                {
                  id: "season-1",
                  kind: MediaKind.SEASON,
                  playability: Playability.NO_AVAILABLE_SOURCE,
                  title: "Season 1",
                },
              ],
              nextPageToken: "next-children-page",
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.listChildren(
          { pageSize: 5, pageToken: "children-page", parentMediaId: "show-1" },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({
        pageSize: 5,
        pageToken: "children-page",
        parentMediaId: "show-1",
        principalId: PRINCIPAL_ID,
      });
      expect(response).toMatchObject({
        items: [{ id: "season-1", title: "Season 1" }],
        nextPageToken: "next-children-page",
      });
    }),
  ),
);

it.effect("serves GetMediaSource through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* librarySourceHandlerTest() {
      const received = { mediaId: "", principalId: "", sourceId: "" };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        getMediaSource: (principalId, request) => {
          received.mediaId = request.mediaId;
          received.principalId = principalId;
          received.sourceId = request.sourceId;
          return Effect.succeed(
            create(GetMediaSourceResponseSchema, {
              source: {
                availability: SourceAvailability.AVAILABLE,
                id: "source-1",
                mediaId: "media-1",
                parts: [],
              },
            }),
          );
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.getMediaSource(
          { mediaId: "media-1", sourceId: "source-1" },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({
        mediaId: "media-1",
        principalId: PRINCIPAL_ID,
        sourceId: "source-1",
      });
      expect(response.source).toMatchObject({
        availability: SourceAvailability.AVAILABLE,
        id: "source-1",
        mediaId: "media-1",
        parts: [],
      });
    }),
  ),
);

it.effect("serves ResolveArtwork through the authenticated stored catalog boundary", () =>
  Effect.scoped(
    Effect.gen(function* libraryArtworkHandlerTest() {
      const received = {
        artworkId: "",
        maxHeight: undefined as number | undefined,
        maxWidth: undefined as number | undefined,
        principalId: "",
      };
      const catalogQuery = CatalogQuery.of({
        ...unusedCatalogQuery,
        resolveArtwork: (principalId, request) => {
          received.artworkId = request.artworkId;
          received.maxHeight = request.maxHeight;
          received.maxWidth = request.maxWidth;
          received.principalId = principalId;
          return Effect.succeed(ARTWORK_RESPONSE);
        },
      });
      const client = yield* startLibraryClient(catalogQuery);

      const response = yield* Effect.promise(() =>
        client.resolveArtwork(
          { artworkId: "artwork-1", maxHeight: 1080, maxWidth: 1920 },
          { headers: { authorization: "Bearer library-reader" } },
        ),
      );

      expect(received).toEqual({
        artworkId: "artwork-1",
        maxHeight: 1080,
        maxWidth: 1920,
        principalId: PRINCIPAL_ID,
      });
      expect(response.locator).toMatchObject({
        allowedRedirectOrigins: ["https://media.example.test"],
        headers: [],
        url: "https://media.example.test/artwork",
      });
    }),
  ),
);
