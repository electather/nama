// oxlint-disable import/max-dependencies -- The HTTP composition boundary wires lifecycle, health, Connect, OAuth, database, and LAN advertisement onto one listener.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Cause, Context, Effect, Exit, Fiber, Layer, Scope } from "effect";

import { BetterAuthAdapter } from "../authentication/better-auth-adapter.ts";
import { ArtworkAccess } from "../catalog/catalog-artwork-access.ts";
import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { RuntimeControl } from "../lifecycle/runtime-control.ts";
import { isArtworkRequest, makeArtworkRequestListener } from "./artwork-listener.ts";
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
const PATH_START_INDEX = 0;
const oauthMethodByPath: Readonly<Record<string, "GET" | "POST">> = Object.freeze({
  "/.well-known/oauth-authorization-server": "GET",
  "/.well-known/oauth-protected-resource": "GET",
  "/device/code": "POST",
  "/jwks": "GET",
  "/oauth2/revoke": "POST",
  "/oauth2/token": "POST",
});

const requestPath = (request: IncomingMessage): string => {
  const target = request.url ?? "";
  const queryIndex = target.indexOf("?");
  if (queryIndex < PATH_START_INDEX) {
    return target;
  }
  return target.slice(PATH_START_INDEX, queryIndex);
};

const makeApplicationRequestListener =
  (
    artworkRequest: RequestListener,
    oauthRequest: RequestListener,
    connectRequest: RequestListener,
  ): RequestListener =>
  (request, response) => {
    if (isArtworkRequest(request)) {
      artworkRequest(request, response);
      return;
    }
    const path = requestPath(request);
    if (oauthMethodByPath[path] === request.method) {
      oauthRequest(request, response);
      return;
    }
    connectRequest(request, response);
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
  // oxlint-disable-next-line eslint/max-statements -- One scoped acquisition sequence owns the listener and every shutdown dependency.
  Effect.gen(function* makeHttpServer() {
    const config = yield* Config;
    const betterAuthAdapter = yield* BetterAuthAdapter;
    const artworkAccess = yield* ArtworkAccess;
    const database = yield* Database;
    const runtimeControl = yield* RuntimeControl;
    const scope = yield* Effect.scope;
    const requestRuntime = yield* makeRequestRuntime(database);
    const accepting: AcceptingState = { value: true };
    const healthStatus = makeHealthStatus(database.checkReadiness, runtimeControl.isReady);
    const connectRequest = unmatchedRequest ?? (yield* makeConnectRequestListener(requestRuntime));
    const listener = makeRequestListener({
      accepting,
      healthStatus,
      requestRuntime,
      unmatchedRequest:
        unmatchedRequest ??
        makeApplicationRequestListener(
          makeArtworkRequestListener(artworkAccess, requestRuntime),
          betterAuthAdapter.oauthRequestListener,
          connectRequest,
        ),
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
