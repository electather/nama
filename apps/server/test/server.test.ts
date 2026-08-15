import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";

import { Database } from "../src/database.ts";
import { EPHEMERAL_PORT, HOST, reservePort, withReservedPort } from "./network.test-support.ts";
import {
  EXPECTED_READINESS_TRANSITIONS,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  SINGLE_CONNECTION,
  openCapturedSocket,
  sendReadyRequest,
  serverLayer,
  serverLayerWithDatabase,
  startServer,
  statusesFrom,
  waitForShortDelay,
  waitForSocketClose,
} from "./server.test-support.ts";
import type { CapturedSocket } from "./server.test-support.ts";

const HTTP_DELEGATED = 418;

const expectEmptyResponse = (response: Response, status: number) =>
  Effect.gen(function* emptyResponseAssertion() {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-length")).toBe("0");
    expect(yield* Effect.promise(() => response.text())).toBe("");
  });

const expectReadyResponse = (origin: string, status: number) =>
  Effect.promise(() => fetch(`${origin}/health/ready`)).pipe(
    Effect.flatMap((response) => expectEmptyResponse(response, status)),
  );

interface ShutdownSocketScenario {
  readonly assertBeforeRelease: () => void;
  readonly client: CapturedSocket;
  readonly close: Effect.Effect<void>;
  readonly probe: Deferred.Deferred<void>;
  readonly probeStarted: Deferred.Deferred<void>;
}

const runShutdownSocketScenario = ({
  assertBeforeRelease,
  client,
  close,
  probe,
  probeStarted,
}: ShutdownSocketScenario) =>
  Effect.gen(function* shutdownSocketScenario() {
    yield* sendReadyRequest(client, "keep-alive");
    yield* Deferred.await(probeStarted);
    const [socketClosed, shutdown] = yield* Effect.all([
      Effect.forkChild(waitForSocketClose(client)),
      Effect.forkChild(close),
    ] as const);
    yield* waitForShortDelay;
    yield* sendReadyRequest(client, "close");
    yield* waitForShortDelay;
    assertBeforeRelease();
    yield* Deferred.done(probe, Exit.void);
    yield* Effect.all([Fiber.join(socketClosed), Fiber.join(shutdown)]);
    return statusesFrom(client.read());
  });

const exerciseReadinessTransitions = (origin: string) =>
  Effect.gen(function* readinessTransitions() {
    yield* expectReadyResponse(origin, HTTP_UNAVAILABLE);
    yield* expectReadyResponse(origin, HTTP_UNAVAILABLE);
    yield* expectReadyResponse(origin, HTTP_OK);
    yield* expectReadyResponse(origin, HTTP_OK);
  });

interface DrainScenario {
  readonly close: Effect.Effect<void>;
  readonly origin: string;
  readonly probe: Deferred.Deferred<void>;
  readonly probeStarted: Deferred.Deferred<void>;
}

const verifyGracefulDrain = ({ close, origin, probe, probeStarted }: DrainScenario) =>
  Effect.gen(function* gracefulDrainScenario() {
    const response = yield* Effect.forkChild(Effect.promise(() => fetch(`${origin}/health/ready`)));
    yield* Deferred.await(probeStarted);
    const shutdown = yield* Effect.forkChild(close);
    const disposedEarly = yield* Effect.raceFirst(
      Fiber.join(shutdown).pipe(Effect.as(true)),
      waitForShortDelay.pipe(Effect.as(false)),
    );
    expect(disposedEarly).toBe(false);
    yield* Deferred.done(probe, Exit.void);
    expect((yield* Fiber.join(response)).status).toBe(HTTP_OK);
    yield* Fiber.join(shutdown);
  });

it.live("matches only the exact health method and target", () =>
  Effect.gen(function* exactHealthRoutesTest() {
    let probes = EPHEMERAL_PORT;
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.sync(() => {
          probes += SINGLE_CONNECTION;
          return true;
        }),
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
    const database = Database.of({ checkReadiness: Effect.succeed(true) });
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

    expect(messages).toEqual(["server.stopping", "database.closed"]);
  }),
);

it.live("allows port reuse after partial listener acquisition fails", () =>
  Effect.gen(function* partialListenerAcquisitionTest() {
    const database = Database.of({ checkReadiness: Effect.succeed(true) });
    const port = yield* withReservedPort((reservedPort) =>
      Effect.gen(function* occupiedPortTest() {
        const error = yield* Effect.acquireUseRelease(
          Scope.make(),
          (scope) =>
            Layer.buildWithScope(serverLayer(reservedPort, database), scope).pipe(Effect.flip),
          (scope) => Scope.close(scope, Exit.void),
        );
        expect(error).toMatchObject({ _tag: "ServerBindError" });
        return reservedPort;
      }),
    );

    yield* Effect.acquireUseRelease(
      Scope.make(),
      (scope) => Layer.buildWithScope(serverLayer(port, database), scope),
      (scope) => Scope.close(scope, Exit.void),
    );
  }),
);

it.live("short-circuits readiness after shutdown starts on an active connection", () =>
  Effect.gen(function* readinessShutdownTest() {
    const probeStarted = yield* Deferred.make<void>();
    const probe = yield* Deferred.make<void>();
    let probes = EPHEMERAL_PORT;
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.gen(function* readinessProbe() {
          probes += SINGLE_CONNECTION;
          yield* Deferred.done(probeStarted, Exit.void);
          yield* Deferred.await(probe);
          return true;
        }),
      }),
    );
    const client = yield* openCapturedSocket(server.origin);
    const statuses = yield* runShutdownSocketScenario({
      assertBeforeRelease: () => {
        expect(probes).toBe(SINGLE_CONNECTION);
      },
      client,
      close: server.close,
      probe,
      probeStarted,
    });

    expect(statuses).toEqual([String(HTTP_OK), String(HTTP_UNAVAILABLE)]);
  }),
);

it.live("serves empty responses and logs only database readiness transitions", () =>
  Effect.gen(function* readinessLoggingTest() {
    const states = [false, false, true, true];
    const messages: string[] = [];
    const server = yield* startServer(
      Database.of({ checkReadiness: Effect.sync(() => states.shift() ?? true) }),
      messages,
    );

    const live = yield* Effect.promise(() => fetch(`${server.origin}/health/live`));
    yield* expectEmptyResponse(live, HTTP_OK);
    yield* exerciseReadinessTransitions(server.origin);
    expect(messages.filter((message) => message === "database.readiness_changed")).toHaveLength(
      EXPECTED_READINESS_TRANSITIONS,
    );
  }),
);

it.live("drains an in-flight request before disposing", () =>
  Effect.gen(function* gracefulDrainTest() {
    const probeStarted = yield* Deferred.make<void>();
    const probe = yield* Deferred.make<void>();
    const server = yield* startServer(
      Database.of({
        checkReadiness: Effect.gen(function* readinessProbe() {
          yield* Deferred.done(probeStarted, Exit.void);
          yield* Deferred.await(probe);
          return true;
        }),
      }),
    );

    yield* verifyGracefulDrain({
      close: server.close,
      origin: server.origin,
      probe,
      probeStarted,
    });
  }),
);

const makeDeadlineServer = Effect.gen(function* makeDeadlineTestServer() {
  const port = yield* reservePort;
  const probeStarted = yield* Deferred.make<void>();
  const interrupted = yield* Ref.make(false);
  const database = Database.of({
    checkReadiness: Deferred.done(probeStarted, Exit.void).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Ref.set(interrupted, true)),
    ),
  });
  const scope = yield* Scope.make();
  yield* Layer.buildWithScope(serverLayer(port, database), scope);
  return { interrupted, port, probeStarted, scope };
});

it.effect("interrupts a remaining request at the ten-second shutdown deadline", () =>
  Effect.gen(function* interruptAtDeadline() {
    const state = yield* makeDeadlineServer;
    const request = yield* Effect.forkChild(
      Effect.promise(() => fetch(`http://${HOST}:${state.port}/health/ready`)).pipe(Effect.ignore),
    );
    yield* Deferred.await(state.probeStarted);
    const shutdown = yield* Effect.forkChild(Scope.close(state.scope, Exit.void));
    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");
    yield* Fiber.join(shutdown);

    expect(yield* Ref.get(state.interrupted)).toBe(true);
    yield* Fiber.interrupt(request);
  }),
);
