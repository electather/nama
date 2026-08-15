import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";

import { Database } from "../../database/database.ts";
import {
  SINGLE_CONNECTION,
  serverLayerWithDatabase,
  startServer,
} from "./http-server.test-support.ts";
import {
  EPHEMERAL_PORT,
  HOST,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  expectEmptyResponse,
  reservePort,
} from "./network.test-support.ts";

const HTTP_DELEGATED = 418;

it.live("matches only the exact health method and target", () =>
  Effect.gen(function* exactHealthRoutesTest() {
    let probes = EPHEMERAL_PORT;
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.sync(() => {
          probes += SINGLE_CONNECTION;
          return true;
        }),
        initialization: "setup-eligible",
      }),
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
    expect(probes).toBe(SINGLE_CONNECTION);
  }),
);

it.live("delegates unmatched requests without probing database readiness", () =>
  Effect.gen(function* unmatchedRequestDelegationTest() {
    let probes = EPHEMERAL_PORT;
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.sync(() => {
          probes += SINGLE_CONNECTION;
          return true;
        }),
        initialization: "setup-eligible",
      }),
      [],
      (_request, response) => {
        response.statusCode = HTTP_DELEGATED;
        response.setHeader("Content-Length", "0");
        response.end();
      },
    );

    const response = yield* Effect.promise(() => fetch(`${server.origin}/delegated`));
    yield* expectEmptyResponse(response, HTTP_DELEGATED);
    expect(probes).toBe(EPHEMERAL_PORT);
  }),
);

it.live("releases the listener before its database dependency", () =>
  Effect.gen(function* reverseFinalizationTest() {
    const messages: string[] = [];
    const port = yield* reservePort;
    const database = Database.of({
      checkReadiness: Effect.succeed(true),
      initialization: "setup-eligible",
    });
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
    const database = Database.of({
      checkReadiness: Effect.succeed(true),
      initialization: "setup-eligible",
    });
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
