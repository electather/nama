import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, IncomingMessage, request as sendRequest } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";

import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { BadRequestSchema, ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { WatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { makeJellyfinHandler } from "../handler.ts";
import { isUnknownRecord } from "../value.ts";

const BEARER = "plugin-bearer";
const API_KEY = "provider-api-key";
const TEST_LAUNCH_DOCUMENT_VERSION = 2;
const USER_ID = "provider-user";
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const ITEM_COUNT = 8;
const MAXIMUM_CONCURRENT_READS = 4;
const MAXIMUM_ITEM_REFERENCES = 100;
const MAXIMUM_ITEM_ID_LENGTH = 256;
const EXCESS_COUNT_INCREMENT = 1;
const EXCESS_ITEM_REFERENCE_COUNT = MAXIMUM_ITEM_REFERENCES + EXCESS_COUNT_INCREMENT;
const EXCESS_ITEM_ID_LENGTH = MAXIMUM_ITEM_ID_LENGTH + EXCESS_COUNT_INCREMENT;
const EPHEMERAL_PORT = 0;
const FIRST_RESULT_INDEX = 0;
const LAST_PATH_SEGMENT = -1;
const GET_WATCH_STATES_PATH = "/nama.plugin.v1.WatchStateService/GetWatchStates";
const LIST_WATCH_STATES_PATH = "/nama.plugin.v1.WatchStateService/ListWatchStates";
const PUSH_WATCH_STATES_PATH = "/nama.plugin.v1.WatchStateService/PushWatchStates";
const INVALID_ARGUMENT_CODE = "invalid_argument";
const UNAUTHENTICATED_CODE = "unauthenticated";
const NO_PROVIDER_REQUESTS = 0;
const VALIDATION_FAILED_REASON = "VALIDATION_FAILED";
const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const OUT_OF_RANGE_REASON = "OUT_OF_RANGE";
const ITEM_REFERENCES_FIELD = "item_references";
const OUT_OF_RANGE_PROVIDER_ACTIVITY = "+010000-01-01T00:00:00.000Z";

interface ConcurrencyObservation {
  active: number;
  maximum: number;
  requests: number;
}

interface ConnectResponse {
  readonly body: unknown;
  readonly statusCode: number | undefined;
}
interface ConnectRequest {
  readonly authenticated: boolean;
  readonly body: Readonly<Record<string, unknown>>;
  readonly path: string;
}

const startHandlerServer = async (): Promise<Server> => {
  const server = createServer(
    makeJellyfinHandler({
      bearer: BEARER,
      configuration: { base_url: "http://localhost", user_id: USER_ID },
      credentials: { api_key: API_KEY },
      kind: "instance",
      provider_instance_id: "provider-instance",
      provider_type: "jellyfin",
      revision: "revision",
      socket_path: "unused",
      version: TEST_LAUNCH_DOCUMENT_VERSION,
    }),
  );
  server.listen(EPHEMERAL_PORT, "127.0.0.1");
  await once(server, "listening");
  return server;
};

const serverPort = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Jellyfin handler server did not bind to a TCP address");
  }
  return address.port;
};

const connectHeaders = (
  encodedBody: Buffer,
  authenticated: boolean,
): Record<string, number | string> => {
  const headers: Record<string, number | string> = {
    "connect-protocol-version": "1",
    "content-length": encodedBody.byteLength,
    "content-type": "application/json",
  };
  if (authenticated) {
    headers["authorization"] = `Bearer ${BEARER}`;
  }
  return headers;
};

const sendConnectJson = async (
  server: Server,
  connectRequest: ConnectRequest,
): Promise<IncomingMessage> => {
  const encodedBody = Buffer.from(JSON.stringify(connectRequest.body), "utf8");
  const headers = connectHeaders(encodedBody, connectRequest.authenticated);
  const outgoing = sendRequest({
    headers,
    host: "127.0.0.1",
    method: "POST",
    path: connectRequest.path,
    port: serverPort(server),
  });
  const responseEvent: Promise<unknown[]> = once(outgoing, "response");
  outgoing.end(encodedBody);
  const [responseValue] = await responseEvent;
  if (!(responseValue instanceof IncomingMessage)) {
    throw new Error("Jellyfin handler response was invalid");
  }
  return responseValue;
};

const readConnectResponse = async (response: IncomingMessage): Promise<ConnectResponse> => {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  await once(response, "end");
  const parsedBody: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return { body: parsedBody, statusCode: response.statusCode };
};

const postConnectJson = async (
  server: Server,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<ConnectResponse> => {
  const response = await sendConnectJson(server, { authenticated: true, body, path });
  return readConnectResponse(response);
};

const postUnauthenticatedConnectJson = async (
  server: Server,
  path: string,
): Promise<ConnectResponse> => {
  const response = await sendConnectJson(server, { authenticated: false, body: {}, path });
  return readConnectResponse(response);
};

const providerEndpoint = (input: string | URL | Request): URL => {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
};

const makeObservedProviderFetch =
  (observation: ConcurrencyObservation): typeof fetch =>
  async (input) => {
    observation.requests += 1;
    observation.active += 1;
    observation.maximum = Math.max(observation.maximum, observation.active);
    await Promise.resolve();
    observation.active -= 1;
    const endpoint = providerEndpoint(input);
    const itemId = decodeURIComponent(endpoint.pathname.split("/").at(LAST_PATH_SEGMENT) ?? "");
    return Response.json(
      {
        Id: itemId,
        Type: "Movie",
        UserData: { PlaybackPositionTicks: 0, Played: false },
      },
      { status: HTTP_OK },
    );
  };
const makeOutOfRangeProviderActivityFetch = (): typeof fetch => (input) => {
  const endpoint = providerEndpoint(input);
  const itemId = decodeURIComponent(endpoint.pathname.split("/").at(LAST_PATH_SEGMENT) ?? "");
  return Promise.resolve(
    Response.json(
      {
        Id: itemId,
        Type: "Movie",
        UserData: {
          LastPlayedDate: OUT_OF_RANGE_PROVIDER_ACTIVITY,
          PlaybackPositionTicks: 0,
          Played: false,
        },
      },
      { status: HTTP_OK },
    ),
  );
};

const expectBoundedResponse = (
  response: ConnectResponse,
  observation: ConcurrencyObservation,
): void => {
  assert.equal(response.statusCode, HTTP_OK);
  assert.ok(isUnknownRecord(response.body));
  const { results } = response.body;
  assert.ok(Array.isArray(results));
  assert.equal(results.length, ITEM_COUNT);
  assert.ok(observation.maximum <= MAXIMUM_CONCURRENT_READS);
};
const invalidBoundResponses = (server: Server): Promise<ConnectResponse[]> => {
  const excessReferences = Array.from(
    { length: EXCESS_ITEM_REFERENCE_COUNT },
    (_unusedValue, index) => ({ itemId: `excess-${index}` }),
  );
  return Promise.all([
    postConnectJson(server, GET_WATCH_STATES_PATH, { itemReferences: excessReferences }),
    postConnectJson(server, GET_WATCH_STATES_PATH, {
      itemReferences: [{ itemId: "x".repeat(EXCESS_ITEM_ID_LENGTH) }],
    }),
  ]);
};

const expectInvalidArgument = (response: ConnectResponse): void => {
  assert.equal(response.statusCode, HTTP_BAD_REQUEST);
  assert.ok(isUnknownRecord(response.body));
  assert.equal(response.body["code"], INVALID_ARGUMENT_CODE);
};
const expectUnauthenticated = (response: ConnectResponse): void => {
  assert.equal(response.statusCode, HTTP_UNAUTHORIZED);
  assert.ok(isUnknownRecord(response.body));
  assert.equal(response.body["code"], UNAUTHENTICATED_CODE);
};
const captureConnectError = async (promise: Promise<unknown>): Promise<ConnectError> => {
  try {
    await promise;
  } catch (error) {
    return ConnectError.from(error);
  }
  throw new Error("Expected Connect call to fail");
};

const expectValidationDetails = async (server: Server): Promise<void> => {
  const client = createClient(
    WatchStateService,
    createConnectTransport({
      baseUrl: `http://127.0.0.1:${serverPort(server)}`,
      httpVersion: "1.1",
    }),
  );
  const itemReferences = Array.from(
    { length: EXCESS_ITEM_REFERENCE_COUNT },
    (_unusedValue, index) => ({ itemId: `detail-${index}` }),
  );
  const error = await captureConnectError(
    client.getWatchStates({ itemReferences }, { headers: { authorization: `Bearer ${BEARER}` } }),
  );
  assert.equal(error.code, Code.InvalidArgument);
  const [errorInfo] = error.findDetails(ErrorInfoSchema);
  assert.equal(errorInfo?.reason, VALIDATION_FAILED_REASON);
  assert.equal(errorInfo?.domain, PLUGIN_ERROR_DOMAIN);
  const [badRequest] = error.findDetails(BadRequestSchema);
  assert.deepEqual(
    badRequest?.fieldViolations.map(({ field, reason }) => ({ field, reason })),
    [{ field: ITEM_REFERENCES_FIELD, reason: OUT_OF_RANGE_REASON }],
  );
};
const expectRejectedBounds = async (
  server: Server,
  observation: ConcurrencyObservation,
): Promise<void> => {
  const responses = await invalidBoundResponses(server);
  responses.forEach((response) => {
    expectInvalidArgument(response);
  });
  assert.equal(observation.requests, NO_PROVIDER_REQUESTS);
  await expectValidationDetails(server);
};

const expectProviderActivityAbsent = (response: ConnectResponse): void => {
  assert.equal(response.statusCode, HTTP_OK);
  assert.ok(isUnknownRecord(response.body));
  const results: unknown = response.body["results"];
  assert.ok(Array.isArray(results));
  const result: unknown = results[FIRST_RESULT_INDEX];
  assert.ok(isUnknownRecord(result));
  const state: unknown = result["state"];
  assert.ok(isUnknownRecord(state));
  assert.ok(!("providerActivity" in state));
};

void test("bounds concurrent targeted provider reads", async () => {
  const observation: ConcurrencyObservation = { active: 0, maximum: 0, requests: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeObservedProviderFetch(observation);
  const server = await startHandlerServer();
  try {
    const itemReferences = Array.from({ length: ITEM_COUNT }, (_unusedValue, index) => ({
      itemId: `item-${index}`,
    }));
    const response = await postConnectJson(server, GET_WATCH_STATES_PATH, { itemReferences });
    expectBoundedResponse(response, observation);
  } finally {
    globalThis.fetch = originalFetch;
    await server[Symbol.asyncDispose]();
  }
});

void test("omits provider activity outside the Protobuf timestamp range", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeOutOfRangeProviderActivityFetch();
  const server = await startHandlerServer();
  try {
    const response = await postConnectJson(server, GET_WATCH_STATES_PATH, {
      itemReferences: [{ itemId: "out-of-range-activity" }],
    });
    expectProviderActivityAbsent(response);
  } finally {
    globalThis.fetch = originalFetch;
    await server[Symbol.asyncDispose]();
  }
});

void test("rejects targeted request bounds before provider calls", async () => {
  const observation: ConcurrencyObservation = { active: 0, maximum: 0, requests: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeObservedProviderFetch(observation);
  const server = await startHandlerServer();
  try {
    await expectRejectedBounds(server, observation);
  } finally {
    globalThis.fetch = originalFetch;
    await server[Symbol.asyncDispose]();
  }
});

void test("authenticates every watch-state method before dispatch", async () => {
  const server = await startHandlerServer();
  try {
    const responses = await Promise.all([
      postUnauthenticatedConnectJson(server, LIST_WATCH_STATES_PATH),
      postUnauthenticatedConnectJson(server, PUSH_WATCH_STATES_PATH),
    ]);
    responses.forEach((response) => {
      expectUnauthenticated(response);
    });
  } finally {
    await server[Symbol.asyncDispose]();
  }
});
