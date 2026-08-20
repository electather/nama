import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";

import { createJellyfinRequest } from "../request.ts";

const API_KEY = String.raw`jellyfin\api-key-sentinel`;
const EXPECTED_AUTHORIZATION = String.raw`MediaBrowser Token="jellyfin\\api-key-sentinel"`;
const SERVER_ID = "server-identity";
const TIGHT_RESPONSE_LIMIT_BYTES = 64;
const LARGER_RESPONSE_LIMIT_BYTES = 512;
const RESPONSE_PADDING_LENGTH = 128;
const EPHEMERAL_PORT = 0;
const HTTP_SERVICE_UNAVAILABLE = 503;
const EXPECTED_CANCELLATIONS = 1;

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly url: string;
}

const observedRequests: ObservedRequest[] = [];
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  observedRequests.push({ authorization: request.headers.authorization, url: request.url ?? "" });
  if (request.url === "/bounded/Data") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ Id: SERVER_ID, Padding: "x".repeat(RESPONSE_PADDING_LENGTH) }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
let origin = "";

const appliesSelectedResponseLimit = async (): Promise<void> => {
  const request = createJellyfinRequest({ apiKey: API_KEY, baseUrl: `${origin}/bounded` });
  assert.ok(request);
  const { signal } = new AbortController();

  const rejected = await request.requestJson(["Data"], {
    authentication: "api_key",
    maximumResponseBytes: TIGHT_RESPONSE_LIMIT_BYTES,
    signal,
  });
  const accepted = await request.requestJson(["Data"], {
    authentication: "api_key",
    maximumResponseBytes: LARGER_RESPONSE_LIMIT_BYTES,
    signal,
  });

  assert.deepEqual(rejected, { kind: "incompatible" });
  assert.equal(accepted.kind, "success");
  assert.deepEqual(observedRequests, [
    {
      authorization: EXPECTED_AUTHORIZATION,
      url: "/bounded/Data",
    },
    {
      authorization: EXPECTED_AUTHORIZATION,
      url: "/bounded/Data",
    },
  ]);
};

const rejectsEscapingPath = async (): Promise<void> => {
  const request = createJellyfinRequest({ apiKey: API_KEY, baseUrl: `${origin}/jellyfin` });
  assert.ok(request);

  const result = await request.requestJson(["..", "outside"], {
    authentication: "none",
    maximumResponseBytes: LARGER_RESPONSE_LIMIT_BYTES,
    signal: new AbortController().signal,
  });

  assert.deepEqual(result, { kind: "incompatible" });
  assert.deepEqual(observedRequests, []);
};
const cancelsNonSuccessResponseBody = async (): Promise<void> => {
  const originalFetch = globalThis.fetch;
  let cancellations = 0;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel: () => {
            cancellations += EXPECTED_CANCELLATIONS;
          },
        }),
        { status: HTTP_SERVICE_UNAVAILABLE },
      ),
    );
  try {
    const request = createJellyfinRequest({ apiKey: API_KEY, baseUrl: `${origin}/unavailable` });
    assert.ok(request);
    const result = await request.requestJson(["Data"], {
      authentication: "api_key",
      maximumResponseBytes: LARGER_RESPONSE_LIMIT_BYTES,
      signal: new AbortController().signal,
    });

    assert.deepEqual(result, { kind: "unreachable" });
    assert.equal(cancellations, EXPECTED_CANCELLATIONS);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

void describe("Jellyfin request", () => {
  before(async () => {
    server.listen(EPHEMERAL_PORT, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Controlled Jellyfin server did not bind to a TCP address");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await server[Symbol.asyncDispose]();
  });

  beforeEach(() => {
    observedRequests.length = 0;
  });

  void it("applies the response limit selected by each request", appliesSelectedResponseLimit);
  void it("rejects a path that escapes the configured prefix", rejectsEscapingPath);
  void it("cancels a non-success provider response body", cancelsNonSuccessResponseBody);
});
