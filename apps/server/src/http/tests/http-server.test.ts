import type { RequestListener } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted, Scope } from "effect";

import { Config } from "../../config/config.ts";
import { Database } from "../../database/database.ts";
import { RuntimeControl } from "../../lifecycle/runtime-control.ts";
import { HttpServer } from "../http-server.ts";
import {
  makeDatabase,
  makeHttpServerTestDependencies,
  serverLayerWithDatabase,
  startServer,
} from "./http-server.test-support.ts";
import {
  HOST,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  expectEmptyResponse,
  reservePort,
} from "./network.test-support.ts";

const HTTP_DELEGATED = 418;
const NO_DATABASE_PROBES = 0;
const ONE_DATABASE_PROBE = 1;
const REQUEST_ID_HEADER = "nama-request-id";
const CONNECT_SUCCESS_CODE = 0;
const FIRST_RPC_COMPLETION_RECORD = 0;
const SINGLE_RPC_COMPLETION_RECORD = 1;
const TEST_SERVER_MAX_CONNECTIONS = 1;

const isGetStatusCompletionRecord = (value: unknown, requestId: string): boolean => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    !("durationMs" in value) ||
    !("event" in value) ||
    !("method" in value) ||
    !("requestId" in value)
  ) {
    return false;
  }
  return (
    value.code === CONNECT_SUCCESS_CODE &&
    typeof value.durationMs === "number" &&
    value.event === "rpc.completed" &&
    value.method === "nama.api.v1.SetupService.GetStatus" &&
    value.requestId === requestId
  );
};

const requireResponseHeader = (response: Response, name: string): string => {
  const value = response.headers.get(name);
  if (value === null) {
    throw new Error(`response must have ${name}`);
  }
  return value;
};

const expectGetStatusResponse = (response: Response) =>
  Effect.gen(function* getStatusResponseAssertion() {
    expect(response.status).toBe(HTTP_OK);
    const body: unknown = yield* Effect.promise<unknown>(() => response.json());
    expect(body).toEqual({ initialized: true });
  });

const expectGetStatusCorrelation = (
  response: Response,
  clientRequestId: string,
  records: readonly unknown[],
): void => {
  const requestId = requireResponseHeader(response, REQUEST_ID_HEADER);
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
  expect(requestId).not.toBe(clientRequestId);
  expect(records).toHaveLength(SINGLE_RPC_COMPLETION_RECORD);
  const loggedRecord = records[FIRST_RPC_COMPLETION_RECORD];
  const loggedRecordMatchesRequest = isGetStatusCompletionRecord(loggedRecord, requestId);
  expect(loggedRecordMatchesRequest).toBe(true);
};

const startDelegatedRequestServer = (
  database: Database["Service"],
  unmatchedRequest: RequestListener,
) =>
  Effect.gen(function* delegatedRequestServer() {
    const port = yield* reservePort;
    const config = Config.of({
      database: Object.freeze({
        maxConnections: TEST_SERVER_MAX_CONNECTIONS,
        url: Redacted.make("postgres://unused"),
      }),
      logging: Object.freeze({ level: "info" as const }),
      security: Object.freeze({ masterKey: Redacted.make("unused") }),
      server: Object.freeze({
        bind: `${HOST}:${port}`,
        publicUrl: `http://${HOST}:${port}/`,
      }),
    });
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const runtimeDependencies = makeHttpServerTestDependencies(
      config,
      database,
      RuntimeControl.layer,
    );
    const serverLayer = HttpServer.layer({ unmatchedRequest }).pipe(
      Layer.provide(runtimeDependencies),
    );
    yield* Layer.buildWithScope(serverLayer, scope);
    return { origin: `http://${HOST}:${port}` };
  });

it.live("matches only the exact health method and target", () =>
  Effect.gen(function* exactHealthRoutesTest() {
    let probes = NO_DATABASE_PROBES;
    const server = yield* startServer(
      makeDatabase(
        Effect.sync(() => {
          probes += ONE_DATABASE_PROBE;
          return true;
        }),
      ),
    );

    const [live, ready, wrongMethod, query, trailingSlash, unknown] = yield* Effect.all([
      Effect.promise(() => fetch(`${server.origin}/health/live`)),
      Effect.promise(() => fetch(`${server.origin}/health/ready`)),
      Effect.promise(() => fetch(`${server.origin}/health/live`, { method: "POST" })),
      Effect.promise(() => fetch(`${server.origin}/health/live?check=true`)),
      Effect.promise(() => fetch(`${server.origin}/health/ready/`)),
      Effect.promise(() => fetch(`${server.origin}/unknown`)),
    ] as const);
    expect([live.status, ready.status]).toEqual([HTTP_OK, HTTP_OK]);
    expect([wrongMethod.status, query.status, trailingSlash.status, unknown.status]).toEqual([
      HTTP_NOT_FOUND,
      HTTP_NOT_FOUND,
      HTTP_NOT_FOUND,
      HTTP_NOT_FOUND,
    ]);
    expect(probes).toBe(ONE_DATABASE_PROBE);
  }),
);

it.live(
  "dispatches Setup GetStatus through Connect with server correlation and terminal logging",
  () =>
    Effect.gen(function* defaultConnectDispatchTest() {
      const records: unknown[] = [];
      const clientRequestId = "client-controlled-request-id";
      const server = yield* startServer(makeDatabase(Effect.succeed(true)), { records });

      const response = yield* Effect.promise(() =>
        fetch(`${server.origin}/nama.api.v1.SetupService/GetStatus`, {
          body: "{}",
          headers: {
            "content-type": "application/json",
            [REQUEST_ID_HEADER]: clientRequestId,
          },
          method: "POST",
        }),
      );
      yield* expectGetStatusResponse(response);

      expectGetStatusCorrelation(response, clientRequestId, records);
    }),
);

it.live("delegates unmatched requests without probing database readiness", () =>
  Effect.gen(function* unmatchedRequestDelegationTest() {
    let probes = NO_DATABASE_PROBES;
    const server = yield* startDelegatedRequestServer(
      makeDatabase(
        Effect.sync(() => {
          probes += ONE_DATABASE_PROBE;
          return true;
        }),
      ),
      (_request, response) => {
        response.statusCode = HTTP_DELEGATED;
        response.setHeader("Content-Length", "0");
        response.end();
      },
    );

    const response = yield* Effect.promise(() => fetch(`${server.origin}/delegated`));
    yield* expectEmptyResponse(response, HTTP_DELEGATED);
    expect(probes).toBe(NO_DATABASE_PROBES);
  }),
);

it.live("releases the listener before its database dependency", () =>
  Effect.gen(function* reverseFinalizationTest() {
    const messages: string[] = [];
    const port = yield* reservePort;
    const database = makeDatabase(Effect.succeed(true));
    const databaseLayer = Layer.effect(
      Database,
      Effect.acquireRelease(Effect.succeed(database), () =>
        Effect.sync(() => {
          messages.push("database.closed");
        }),
      ),
    );
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(serverLayerWithDatabase(port, databaseLayer, { messages }), scope);
    yield* Scope.close(scope, Exit.void);

    expect(messages).toEqual(["database.closed"]);
  }),
);

it.live("marks the listener unavailable before emitting stopping", () =>
  Effect.gen(function* stoppingOrderTest() {
    const port = yield* reservePort;
    const database = makeDatabase(Effect.succeed(true));
    let observedStopping = false;
    const emitStopping = () =>
      Effect.promise(() => fetch(`http://${HOST}:${port}/health/ready`)).pipe(
        Effect.tap((response) =>
          Effect.sync(() => {
            expect(response.status).toBe(HTTP_UNAVAILABLE);
            observedStopping = true;
          }),
        ),
        Effect.asVoid,
      );
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      serverLayerWithDatabase(port, Layer.succeed(Database, database), { emitStopping }),
      scope,
    );
    yield* Scope.close(scope, Exit.void);

    expect(observedStopping).toBe(true);
  }),
);
