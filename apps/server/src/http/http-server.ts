import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Context, Effect, Exit, Layer } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { makeHealthStatus } from "./health.ts";
import type { HealthStatusEffect } from "./health.ts";
import { closeListener, openListener, sendEmpty } from "./listener.ts";
import type { ListenerShutdown } from "./listener.ts";
import { makeRequestRuntime } from "./request-runtime.ts";
import type { RequestRuntime } from "./request-runtime.ts";

const HTTP_NOT_FOUND = 404;

interface AcceptingState {
  value: boolean;
}

interface HttpServerService {
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

const notFoundRequest: RequestListener = (_request, response) => {
  sendEmpty(response, HTTP_NOT_FOUND);
};

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

const makeServer = (unmatchedRequest: RequestListener, emitStopping: () => Effect.Effect<void>) =>
  Effect.gen(function* makeHttpServer() {
    const config = yield* Config;
    const database = yield* Database;
    const requestRuntime = yield* makeRequestRuntime(database);
    const accepting: AcceptingState = { value: true };
    const healthStatus = makeHealthStatus(database.checkReadiness);
    const listener = makeRequestListener({
      accepting,
      healthStatus,
      requestRuntime,
      unmatchedRequest,
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
    void server;
    return HttpServer.of({ listening: true });
  });

class HttpServer extends contextService<HttpServer, HttpServerService>()(
  "@nama/server/HttpServer",
) {
  static readonly layer = ({
    emitStopping = () => Effect.void,
    unmatchedRequest = notFoundRequest,
  }: HttpServerLayerOptions = {}) =>
    Layer.effect(HttpServer, makeServer(unmatchedRequest, emitStopping));
}

export { HttpServer };
