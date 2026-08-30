// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, unicorn/max-nested-calls -- This real subprocess scenario keeps the complete provider exchange and ordered safe-failure matrix visible at the generated Connect seam.
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";

import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { ArtworkAuthorizationScope, LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import {
  PluginConnectionStatus,
  PluginService,
  ProviderCapability,
} from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect, Fiber, Redacted } from "effect";

import { configuredLoggingLayer } from "../../src/logging/logging.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 2000;
const TEST_TIMEOUT_MILLISECONDS = 10_000;
const EMPTY_LENGTH = 0;
const PRIMARY_ARTWORK_INDEX = 0;
const BACKDROP_ARTWORK_INDEX = 1;
const NO_DIMENSION_PREFERENCE = 0;
const OVERSIZED_MIME_PADDING_LENGTH = 300;
const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const API_KEY = "jellyfin-artwork-api-key-sentinel";
const SERVER_ID = "artwork-server-identity";
const USER_ID = "artwork-user-identity";
const MOVIE_ID = "0123456789abcdef0123456789abcdef";
const PUBLIC_MOVIE_ID = "01234567-89ab-cdef-0123-456789abcdef";
const BACKDROP_CACHE_TAG = "backdrop-cache-tag";
const CACHE_TAG = "poster-cache-tag";
const MAXIMUM_WIDTH = 600;
const MAXIMUM_HEIGHT = 900;
const STOCK_CAPABILITIES = [
  ProviderCapability.LIBRARY_READ,
  ProviderCapability.ARTWORK_RESOLVE,
  ProviderCapability.WATCH_STATE_READ,
  ProviderCapability.WATCHED_WRITE,
];
const PLUGIN_CAPABILITIES = [
  ...STOCK_CAPABILITIES,
  ProviderCapability.PLAYBACK_PLAN,
  ProviderCapability.PLAYBACK_OPEN,
  ProviderCapability.PLAYBACK_REPORT,
  ProviderCapability.PLAYBACK_REPORTS_USER_STATE,
];
const REDIRECT_WIDTH = 301;
const PROTECTED_WIDTH = 401;
const MISSING_WIDTH = 404;
const UNAVAILABLE_WIDTH = 503;
const INVALID_CONTENT_WIDTH = 1;
const OVERSIZED_MIME_WIDTH = 2;
const CANCELED_WIDTH = 3;
const NO_CONTENT_WIDTH = 204;
const OVERSIZED_DIMENSION = 2_147_483_648;
const HTTP_REDIRECT = 302;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const PROVIDER_ERROR_SENTINEL = "private-artwork-provider-error";
const HOSTILE_REDIRECT = `https://public.example.test/${API_KEY}`;
const TEST_DATABASE_CONNECTIONS = 1;
const loggingConfig = {
  database: Object.freeze({
    maxConnections: TEST_DATABASE_CONNECTIONS,
    url: Redacted.make("unused"),
  }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("unused") }),
  server: Object.freeze({
    bind: "127.0.0.1:8080",
    lanDiscovery: false,
    publicUrl: "http://127.0.0.1:8080/",
  }),
};

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
  readonly url: string;
}

interface ControlledJellyfin {
  readonly baseUrl: string;
  readonly cancellationObserved: Promise<void>;
  readonly hangingRequestObserved: Promise<void>;
  readonly origin: string;
  readonly requests: ObservedRequest[];
  readonly server: Server;
}

const respondJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

const acquireControlledJellyfin = Effect.acquireRelease(
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<ControlledJellyfin> => {
      const requests: ObservedRequest[] = [];
      const hangingRequest = Promise.withResolvers<void>();
      const cancellation = Promise.withResolvers<void>();
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        requests.push({
          authorization: request.headers.authorization,
          method: request.method,
          url: request.url ?? "",
        });
        if (request.url === "/jellyfin/System/Info/Public") {
          respondJson(response, {
            Id: SERVER_ID,
            ServerName: "Artwork Jellyfin",
            Version: "10.11.11",
          });
          return;
        }
        if (
          request.url === `/jellyfin/Users/${USER_ID}` &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondJson(response, {
            Id: USER_ID,
            Policy: { IsDisabled: false },
            ServerId: SERVER_ID,
          });
          return;
        }
        if (
          request.url === `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}` &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondJson(response, {
            BackdropImageTags: [BACKDROP_CACHE_TAG],
            Id: MOVIE_ID,
            ImageTags: { Primary: CACHE_TAG },
            MediaSources: [],
            Name: "Artwork movie",
            PlayAccess: "Full",
            Type: "Movie",
          });
          return;
        }
        if (
          request.method === "HEAD" &&
          request.headers.authorization === undefined &&
          request.url === `/jellyfin/Items/${PUBLIC_MOVIE_ID}/Images/Backdrop/0`
        ) {
          response.statusCode = HTTP_OK;
          response.setHeader("content-type", "image/png");
          response.end();
          return;
        }
        if (
          request.method === "HEAD" &&
          request.headers.authorization === undefined &&
          request.url ===
            `/jellyfin/Items/${PUBLIC_MOVIE_ID}/Images/Primary/0?maxWidth=${MAXIMUM_WIDTH}&maxHeight=${MAXIMUM_HEIGHT}`
        ) {
          response.statusCode = HTTP_OK;
          response.setHeader("content-type", "IMAGE/JPEG; charset=binary");
          response.end();
          return;
        }
        if (
          request.method === "HEAD" &&
          request.headers.authorization === undefined &&
          request.url?.startsWith(
            `/jellyfin/Items/${PUBLIC_MOVIE_ID}/Images/Primary/0?maxWidth=`,
          ) === true
        ) {
          const endpoint = new URL(request.url, "http://controlled.invalid");
          const maximumWidth = Number(endpoint.searchParams.get("maxWidth"));
          if (maximumWidth === CANCELED_WIDTH) {
            hangingRequest.resolve();
            response.once("close", cancellation.resolve);
            return;
          }
          if (maximumWidth === REDIRECT_WIDTH) {
            response.statusCode = HTTP_REDIRECT;
            response.setHeader("location", HOSTILE_REDIRECT);
          } else if (maximumWidth === PROTECTED_WIDTH) {
            response.statusCode = HTTP_UNAUTHORIZED;
          } else if (maximumWidth === MISSING_WIDTH) {
            response.statusCode = HTTP_NOT_FOUND;
          } else if (maximumWidth === UNAVAILABLE_WIDTH) {
            response.statusCode = HTTP_UNAVAILABLE;
            response.setHeader("x-provider-error", PROVIDER_ERROR_SENTINEL);
          } else if (maximumWidth === INVALID_CONTENT_WIDTH) {
            response.statusCode = HTTP_OK;
            response.setHeader("content-type", "text/html");
          } else if (maximumWidth === OVERSIZED_MIME_WIDTH) {
            response.statusCode = HTTP_OK;
            response.setHeader(
              "content-type",
              `image/${"x".repeat(OVERSIZED_MIME_PADDING_LENGTH)}`,
            );
          } else if (maximumWidth === NO_CONTENT_WIDTH) {
            response.statusCode = HTTP_NO_CONTENT;
            response.setHeader("content-type", "image/png");
          }
          response.end();
          return;
        }
        response.statusCode = HTTP_NOT_FOUND;
        response.end();
      });
      server.listen(EPHEMERAL_PORT, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Controlled Jellyfin server did not bind to a TCP address");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      return {
        baseUrl: `${origin}/jellyfin`,
        cancellationObserved: cancellation.promise,
        hangingRequestObserved: hangingRequest.promise,
        origin,
        requests,
        server,
      };
    },
  }),
  ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
);

const superviseJellyfin = (
  supervisor: PluginSupervisor["Service"],
  baseUrl: string,
  providerInstanceId: string,
) =>
  supervisor.supervise(
    {
      arguments: [JELLYFIN_PLUGIN_PATH],
      executable: process.execPath,
      expectedProviderType: "jellyfin",
      stderrEvents: [],
    },
    {
      configuration: { base_url: baseUrl, user_id: USER_ID },
      credentials: { api_key: API_KEY },
      kind: "instance",
      providerInstanceId,
      revision: "artwork-revision-1",
    },
  );

it.live(
  "resolves an observed Jellyfin artwork reference as an anonymous public lease",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinArtworkTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* superviseJellyfin(
          supervisor,
          jellyfin.baseUrl,
          "artwork-provider-instance",
        );

        const info = yield* plugin.call(
          PluginService.method.getInfo,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(info.pluginInfo?.capabilities).toEqual(PLUGIN_CAPABILITIES);

        const connection = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(connection.connection).toMatchObject({
          capabilities: STOCK_CAPABILITIES,
          status: PluginConnectionStatus.CONNECTED,
        });

        const itemResponse = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        const artworkReference =
          itemResponse.item?.artwork[PRIMARY_ARTWORK_INDEX]?.artworkReference;
        expect(artworkReference?.artworkId).toMatch(/^jellyfin\/artwork\/v1:[\w-]+$/u);
        expect(artworkReference?.artworkId).not.toContain("Primary");
        expect(artworkReference?.artworkId).not.toContain(CACHE_TAG);
        expect(artworkReference?.artworkId).not.toContain(MOVIE_ID);
        expect(artworkReference?.artworkId).not.toContain(API_KEY);

        const artwork = yield* plugin.call(
          LibraryService.method.resolveArtwork,
          {
            artworkReference,
            maxHeight: MAXIMUM_HEIGHT,
            maxWidth: MAXIMUM_WIDTH,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(artwork.lease).toMatchObject({
          allowedRedirectOrigins: [jellyfin.origin],
          authorizationScope: ArtworkAuthorizationScope.PUBLIC,
          headers: [],
          mimeType: "image/jpeg",
          url: `${jellyfin.baseUrl}/Items/${PUBLIC_MOVIE_ID}/Images/Primary/0?maxWidth=${MAXIMUM_WIDTH}&maxHeight=${MAXIMUM_HEIGHT}`,
        });
        const backdropReference =
          itemResponse.item?.artwork[BACKDROP_ARTWORK_INDEX]?.artworkReference;
        const backdrop = yield* plugin.call(
          LibraryService.method.resolveArtwork,
          {
            artworkReference: backdropReference,
            maxHeight: NO_DIMENSION_PREFERENCE,
            maxWidth: NO_DIMENSION_PREFERENCE,
          },
          CALL_DEADLINE_MILLISECONDS,
        );
        expect(backdrop.lease).toMatchObject({
          allowedRedirectOrigins: [jellyfin.origin],
          authorizationScope: ArtworkAuthorizationScope.PUBLIC,
          headers: [],
          mimeType: "image/png",
          url: `${jellyfin.baseUrl}/Items/${PUBLIC_MOVIE_ID}/Images/Backdrop/0`,
        });
        expect(backdrop.lease?.accessExpiresAt).toBeUndefined();
        expect(artwork.lease?.accessExpiresAt).toBeUndefined();
        expect(jellyfin.requests).toEqual([
          {
            authorization: undefined,
            method: "GET",
            url: "/jellyfin/System/Info/Public",
          },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            method: "GET",
            url: `/jellyfin/Users/${USER_ID}`,
          },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            method: "GET",
            url: "/jellyfin/Nama/v1/handshake",
          },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            method: "GET",
            url: `/jellyfin/Items/${MOVIE_ID}?userId=${USER_ID}`,
          },
          {
            authorization: undefined,
            method: "HEAD",
            url: `/jellyfin/Items/${PUBLIC_MOVIE_ID}/Images/Primary/0?maxWidth=${MAXIMUM_WIDTH}&maxHeight=${MAXIMUM_HEIGHT}`,
          },
          {
            authorization: undefined,
            method: "HEAD",
            url: `/jellyfin/Items/${PUBLIC_MOVIE_ID}/Images/Backdrop/0`,
          },
        ]);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  TEST_TIMEOUT_MILLISECONDS,
);

it.live(
  "fails safely when Jellyfin artwork cannot become an anonymous public lease",
  () => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* jellyfinArtworkFailureTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* superviseJellyfin(
          supervisor,
          jellyfin.baseUrl,
          "artwork-failure-provider-instance",
        );
        const itemResponse = yield* plugin.call(
          LibraryService.method.getItem,
          { itemReference: { itemId: MOVIE_ID } },
          CALL_DEADLINE_MILLISECONDS,
        );
        const artworkReference =
          itemResponse.item?.artwork[PRIMARY_ARTWORK_INDEX]?.artworkReference;
        if (artworkReference === undefined) {
          throw new Error("Jellyfin artwork observation was absent");
        }

        const cases = [
          [PROTECTED_WIDTH, Code.PermissionDenied],
          [MISSING_WIDTH, Code.NotFound],
          [REDIRECT_WIDTH, Code.FailedPrecondition],
          [INVALID_CONTENT_WIDTH, Code.FailedPrecondition],
          [OVERSIZED_MIME_WIDTH, Code.FailedPrecondition],
          [NO_CONTENT_WIDTH, Code.FailedPrecondition],
          [UNAVAILABLE_WIDTH, Code.Unavailable],
        ] as const;
        for (const [maxWidth, code] of cases) {
          const failure = yield* plugin
            .call(
              LibraryService.method.resolveArtwork,
              { artworkReference, maxWidth },
              CALL_DEADLINE_MILLISECONDS,
            )
            .pipe(Effect.flip);
          expect(failure).toMatchObject({ _tag: "PluginRpcError", code });
          const serializedFailure = JSON.stringify(failure);
          expect(serializedFailure).not.toContain(API_KEY);
          expect(serializedFailure).not.toContain(HOSTILE_REDIRECT);
          expect(serializedFailure).not.toContain(PROVIDER_ERROR_SENTINEL);
          expect(serializedFailure).not.toContain(jellyfin.baseUrl);
        }

        const requestsBeforeLocalRejections = jellyfin.requests.length;
        const invalidReferenceFailure = yield* plugin
          .call(
            LibraryService.method.resolveArtwork,
            {
              artworkReference: {
                artworkId: "jellyfin/artwork/v1:not-canonical",
                itemReference: { itemId: MOVIE_ID },
              },
            },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(invalidReferenceFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.InvalidArgument,
        });
        for (const itemId of [".", ".."]) {
          const dotSegmentFailure = yield* plugin
            .call(
              LibraryService.method.resolveArtwork,
              {
                artworkReference: {
                  artworkId: artworkReference.artworkId,
                  itemReference: { itemId },
                },
              },
              CALL_DEADLINE_MILLISECONDS,
            )
            .pipe(Effect.flip);
          expect(dotSegmentFailure).toMatchObject({
            _tag: "PluginRpcError",
            code: Code.InvalidArgument,
          });
        }
        const oversizedDimensionFailure = yield* plugin
          .call(
            LibraryService.method.resolveArtwork,
            { artworkReference, maxWidth: OVERSIZED_DIMENSION },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(oversizedDimensionFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.InvalidArgument,
        });
        expect(jellyfin.requests).toHaveLength(requestsBeforeLocalRejections);

        const unsafePlugin = yield* superviseJellyfin(
          supervisor,
          "https://public.example.test",
          "unsafe-artwork-provider-instance",
        );
        const unsafeOriginFailure = yield* unsafePlugin
          .call(
            LibraryService.method.resolveArtwork,
            { artworkReference },
            CALL_DEADLINE_MILLISECONDS,
          )
          .pipe(Effect.flip);
        expect(unsafeOriginFailure).toMatchObject({
          _tag: "PluginRpcError",
          code: Code.Internal,
        });
        expect(jellyfin.requests).toHaveLength(requestsBeforeLocalRejections);

        const canceledCall = yield* Effect.forkChild(
          plugin.call(
            LibraryService.method.resolveArtwork,
            { artworkReference, maxWidth: CANCELED_WIDTH },
            TEST_TIMEOUT_MILLISECONDS,
          ),
        );
        yield* Effect.promise(() => jellyfin.hangingRequestObserved);
        yield* Fiber.interrupt(canceledCall);
        yield* Effect.promise(() => jellyfin.cancellationObserved);

        const artworkRequests = jellyfin.requests.filter(({ url }) => url.includes("/Images/"));
        expect(artworkRequests.length).toBeGreaterThan(EMPTY_LENGTH);
        expect(
          artworkRequests.every(
            ({ authorization, method, url }) =>
              authorization === undefined && method === "HEAD" && !url.includes(API_KEY),
          ),
        ).toBe(true);

        const output = lines.join("");
        for (const privateValue of [
          API_KEY,
          HOSTILE_REDIRECT,
          PROVIDER_ERROR_SENTINEL,
          jellyfin.baseUrl,
        ]) {
          expect(output).not.toContain(privateValue);
        }
        expect(output).not.toContain("plugin.stderr_dropped");
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  },
  TEST_TIMEOUT_MILLISECONDS,
);
