import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Effect, Exit } from "effect";

import type {
  ArtworkAccessService,
  StoredArtworkAsset,
} from "../catalog/catalog-artwork-access.ts";
import { sendEmpty } from "./listener.ts";
import type { RequestRuntime } from "./request-runtime.ts";

const ARTWORK_PATH_PREFIX = "/artwork/";
const MAXIMUM_TOKEN_BYTES = 2048;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const EMPTY_LENGTH = 0;

const artworkToken = (request: IncomingMessage): string | undefined => {
  const target = request.url ?? "";
  if (request.method !== "GET" || !target.startsWith(ARTWORK_PATH_PREFIX)) {
    return undefined;
  }
  const token = target.slice(ARTWORK_PATH_PREFIX.length);
  if (
    token.length === EMPTY_LENGTH ||
    token.includes("/") ||
    token.includes("?") ||
    token.includes("#") ||
    Buffer.byteLength(token, "utf8") > MAXIMUM_TOKEN_BYTES
  ) {
    return "";
  }
  return token;
};

const sendArtwork = (response: ServerResponse, asset: StoredArtworkAsset): void => {
  // fallow-ignore-next-line security-sink -- Header names are fixed; MIME is import-validated, constrained to image/* without control characters, and rechecked by PostgreSQL.
  response.writeHead(HTTP_OK, {
    "cache-control": "private, no-store",
    "content-length": asset.bytes.byteLength,
    "content-type": asset.mimeType,
    "x-content-type-options": "nosniff",
  });
  response.end(asset.bytes);
};

const makeArtworkRequestListener =
  (
    artworkAccess: ArtworkAccessService,
    requestRuntime: RequestRuntime,
    now: () => number = Date.now,
  ): RequestListener =>
  (request, response) => {
    const token = artworkToken(request);
    if (token === undefined || token.length === EMPTY_LENGTH) {
      sendEmpty(response, HTTP_NOT_FOUND);
      return;
    }
    const requestEffect = artworkAccess.read(token, now()).pipe(
      Effect.tap((asset) =>
        Effect.sync(() => {
          sendArtwork(response, asset);
        }),
      ),
    );
    requestRuntime.run(requestEffect, (exit) => {
      if (Exit.isFailure(exit) && !response.writableEnded) {
        sendEmpty(response, HTTP_NOT_FOUND);
      }
    });
  };

const isArtworkRequest = (request: IncomingMessage): boolean =>
  (request.url ?? "").startsWith(ARTWORK_PATH_PREFIX);

export { isArtworkRequest, makeArtworkRequestListener };
