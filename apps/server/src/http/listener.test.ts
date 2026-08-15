import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect";
import { TestClock } from "effect/testing";

import { Database } from "../database/database.ts";
import { SINGLE_CONNECTION, serverLayer, startServer } from "./http-server.test-support.ts";
import {
  EPHEMERAL_PORT,
  HOST,
  HTTP_OK,
  HTTP_UNAVAILABLE,
  openCapturedSocket,
  reservePort,
  sendReadyRequest,
  statusesFrom,
  waitForShortDelay,
  waitForSocketClose,
  withReservedPort,
} from "./network.test-support.ts";
import type { CapturedSocket } from "./network.test-support.ts";

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
