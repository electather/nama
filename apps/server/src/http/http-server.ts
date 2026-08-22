import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { RuntimeControl } from "../lifecycle/runtime-control.ts";
import { makeConnectRequestListener } from "./connect-listener.ts";
import { makeHealthStatus } from "./health.ts";
import type { HealthStatusEffect } from "./health.ts";
import { runLanAdvertisement } from "./lan-advertiser.ts";
import { closeListener, openListener, sendEmpty } from "./listener.ts";
import type { ListenerShutdown } from "./listener.ts";
import { makeRequestRuntime } from "./request-runtime.ts";
import type { RequestRuntime } from "./request-runtime.ts";

interface AcceptingState {
  value: boolean;
}

interface HttpServerService {
  readonly advertiseLan: Effect.Effect<void>;
  readonly listening: true;
}

interface RequestListenerOptions {
  readonly accepting: AcceptingState;
  readonly healthStatus: HealthStatusEffect;
  readonly requestRuntime: RequestRuntime;
  readonly unmatchedRequest: RequestListener;
}

interface HttpServerLayerOptions {
  readonly emitStopping?: (() => Effect.Effect<void>) | undefined;
  readonly unmatchedRequest?: RequestListener | undefined;
}

const contextService = Context.Service;

const makeRequestListener =
  ({ accepting, healthStatus, requestRuntime, unmatchedRequest }: RequestListenerOptions) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    const target = request.url;
    if (request.method !== "GET" || (target !== "/health/live" && target !== "/health/ready")) {
      unmatchedRequest(request, response);
      return;
    }

    const requestEffect = healthStatus(accepting.value, target).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          sendEmpty(response, status);
        }),
      ),
    );
    requestRuntime.run(requestEffect, (exit) => {
      if (Exit.isFailure(exit) && !response.writableEnded) {
        response.destroy();
      }
    });
  };

const stopLanAdvertisement = <Error>(fiber: Fiber.Fiber<void, Error>) =>
  Fiber.interrupt(fiber).pipe(
    Effect.andThen(Fiber.await(fiber)),
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        return Effect.failCause(exit.cause);
      }
      return Effect.void;
    }),
    Effect.orDie,
  );

const makeServer = (
  unmatchedRequest: RequestListener | undefined,
  emitStopping: () => Effect.Effect<void>,
) =>
  Effect.gen(function* makeHttpServer() {
    const config = yield* Config;
    const database = yield* Database;
    const runtimeControl = yield* RuntimeControl;
    const scope = yield* Effect.scope;
    const requestRuntime = yield* makeRequestRuntime(database);
    const accepting: AcceptingState = { value: true };
    const healthStatus = makeHealthStatus(database.checkReadiness, runtimeControl.isReady);
    const listener = makeRequestListener({
      accepting,
      healthStatus,
      requestRuntime,
      unmatchedRequest: unmatchedRequest ?? (yield* makeConnectRequestListener(requestRuntime)),
    });
    const server = yield* Effect.acquireRelease(
      openListener(config.server.bind, listener),
      (acquired) =>
        closeListener(acquired, {
          awaitRequests: requestRuntime.awaitRequests,
          emitStopping,
          interruptRequests: requestRuntime.interruptRequests,
          markNotAccepting: () => {
            accepting.value = false;
          },
        } satisfies ListenerShutdown).pipe(Effect.orDie),
    );
    return HttpServer.of({
      advertiseLan: Effect.gen(function* startLanAdvertisement() {
        const advertisement = runLanAdvertisement(config.server, server.address());
        const fiber = yield* Effect.forkIn(advertisement, scope);
        yield* Scope.addFinalizer(scope, stopLanAdvertisement(fiber));
      }),
      listening: true,
    });
  });

class HttpServer extends contextService<HttpServer, HttpServerService>()(
  "@nama/server/HttpServer",
) {
  static readonly layer = ({
    emitStopping = () => Effect.void,
    unmatchedRequest,
  }: HttpServerLayerOptions = {}) =>
    Layer.effect(HttpServer, makeServer(unmatchedRequest, emitStopping));
}

export { HttpServer };
