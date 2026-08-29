import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, it } from "@effect/vitest";
import { ArtworkAuthorizationScope } from "@nama/api/nama/plugin/v1/library_pb.js";
import type { ProviderArtworkLease } from "@nama/api/nama/plugin/v1/library_pb.js";
import { Effect } from "effect";

import { makeArtworkAssetLoader } from "../catalog-artwork-asset-fetch.ts";

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;
const EPHEMERAL_PORT = 0;
const NOW = new Date("2026-08-29T12:00:00.000Z").getTime();
const ASSET_BYTES = Buffer.from("canonical-artwork", "utf8");
const OVERSIZED_ARTWORK_BYTES = 20_971_521;
const INPUT = {
  artworkReference: "private-artwork",
  itemReference: "private-item",
  maxHeight: 1920,
  maxWidth: 1920,
  now: NOW,
  providerInstanceId: "provider-instance",
  revision: "provider-revision",
} as const;

const sendArtwork = (response: ServerResponse): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-type", "image/jpeg");
  response.end(ASSET_BYTES);
};

const sendUnsafeRedirect = (response: ServerResponse): void => {
  response.statusCode = HTTP_FOUND;
  response.setHeader("location", "https://attacker.example/poster");
  response.end();
};

const sendWrongMimeType = (response: ServerResponse): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-type", "image/png");
  response.end(ASSET_BYTES);
};

const sendOversizedLength = (response: ServerResponse): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-length", String(OVERSIZED_ARTWORK_BYTES));
  response.setHeader("content-type", "image/jpeg");
  response.end(ASSET_BYTES);
};

const responseByPath: Readonly<Record<string, (response: ServerResponse) => void>> = Object.freeze({
  "/oversized": sendOversizedLength,
  "/poster": sendArtwork,
  "/redirect": sendUnsafeRedirect,
  "/wrong-mime": sendWrongMimeType,
});

const handleArtworkRequest = (request: IncomingMessage, response: ServerResponse): void => {
  const handler = responseByPath[request.url ?? ""];
  if (handler === undefined) {
    response.statusCode = HTTP_NOT_FOUND;
    response.end();
    return;
  }
  handler(response);
};

const controlledArtworkServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const server = createServer(handleArtworkRequest);
    server.listen(EPHEMERAL_PORT, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("artwork test server did not bind");
    }
    return { origin: `http://127.0.0.1:${address.port}`, server };
  }),
  ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
);

interface ArtworkLoadFixture {
  readonly authorizationScope: ArtworkAuthorizationScope;
  readonly headers?: ProviderArtworkLease["headers"] | undefined;
  readonly origin: string;
  readonly path: string;
}

const loadArtwork = ({ authorizationScope, headers = [], origin, path }: ArtworkLoadFixture) => {
  const loader = makeArtworkAssetLoader(() =>
    Effect.succeed({
      approvedOrigins: [origin],
      lease: {
        $typeName: "nama.plugin.v1.ProviderArtworkLease",
        allowedRedirectOrigins: [origin],
        authorizationScope,
        headers,
        mimeType: "image/jpeg",
        url: `${origin}${path}`,
      },
    }),
  );
  return loader(INPUT);
};

it.effect("persists bounded artwork from an approved locator origin", () =>
  Effect.scoped(
    Effect.gen(function* approvedArtworkTest() {
      const { origin } = yield* controlledArtworkServer;
      const asset = yield* loadArtwork({
        authorizationScope: ArtworkAuthorizationScope.PUBLIC,
        origin,
        path: "/poster",
      });
      expect(asset).toEqual({ bytes: ASSET_BYTES, mimeType: "image/jpeg" });
    }),
  ),
);

it.effect("rejects an artwork redirect outside approved origins", () =>
  Effect.scoped(
    Effect.gen(function* unsafeArtworkRedirectTest() {
      const { origin } = yield* controlledArtworkServer;
      const asset = yield* loadArtwork({
        authorizationScope: ArtworkAuthorizationScope.PUBLIC,
        origin,
        path: "/redirect",
      });
      expect(asset).toBeUndefined();
    }),
  ),
);

it.effect("rejects artwork whose response MIME differs from its lease", () =>
  Effect.scoped(
    Effect.gen(function* wrongArtworkMimeTest() {
      const { origin } = yield* controlledArtworkServer;
      const asset = yield* loadArtwork({
        authorizationScope: ArtworkAuthorizationScope.PUBLIC,
        origin,
        path: "/wrong-mime",
      });
      expect(asset).toBeUndefined();
    }),
  ),
);

it.effect("rejects artwork with an oversized declared length", () =>
  Effect.scoped(
    Effect.gen(function* oversizedArtworkTest() {
      const { origin } = yield* controlledArtworkServer;
      const asset = yield* loadArtwork({
        authorizationScope: ArtworkAuthorizationScope.PUBLIC,
        origin,
        path: "/oversized",
      });
      expect(asset).toBeUndefined();
    }),
  ),
);

it.effect("rejects reusable provider-account artwork credentials", () =>
  Effect.scoped(
    Effect.gen(function* providerAccountArtworkTest() {
      const { origin } = yield* controlledArtworkServer;
      const asset = yield* loadArtwork({
        authorizationScope: ArtworkAuthorizationScope.PROVIDER_ACCOUNT,
        headers: [
          {
            $typeName: "nama.plugin.v1.HttpHeader",
            name: "Authorization",
            value: "reusable-provider-secret",
          },
        ],
        origin,
        path: "/poster",
      });
      expect(asset).toBeUndefined();
    }),
  ),
);
