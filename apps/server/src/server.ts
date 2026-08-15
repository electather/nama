import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import {
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  References,
} from "effect";

import { Config } from "./config.ts";
import { Database } from "./database.ts";

const SHUTDOWN_TIMEOUT = 10_000;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const FIRST_INDEX = 0;
const NEXT_CHARACTER_OFFSET = 1;
const LAST_INDEX = -1;

type HealthTarget = "/health/live" | "/health/ready";
type HealthStatus = typeof HTTP_OK | typeof HTTP_UNAVAILABLE;

interface AcceptingState {
  value: boolean;
}

interface HttpServerService {
  readonly listening: true;
}
interface HealthRequest {
  readonly accepting: boolean;
  readonly checkReadiness: Effect.Effect<boolean>;
  readonly target: HealthTarget;
}

const taggedError = Data.TaggedError;
const contextService = Context.Service;
const ServerBindError = taggedError("ServerBindError");
const ShutdownError = taggedError("ShutdownError");
type ServerBindFailure = InstanceType<typeof ServerBindError>;
type ShutdownFailure = InstanceType<typeof ShutdownError>;

const healthStatus = ({
  accepting,
  checkReadiness,
  target,
}: HealthRequest): Effect.Effect<HealthStatus> => {
  if (target === "/health/live") {
    return Effect.succeed(HTTP_OK);
  }
  if (!accepting) {
    return Effect.succeed(HTTP_UNAVAILABLE);
  }
  return checkReadiness.pipe(
    Effect.map((ready) => {
      if (ready) {
        return HTTP_OK;
      }
      return HTTP_UNAVAILABLE;
    }),
  );
};

const parseBind = (bind: string): { readonly host: string; readonly port: number } => {
  const separator = bind.lastIndexOf(":");
  const rawHost = bind.slice(FIRST_INDEX, separator);
  let host = rawHost;
  if (rawHost.startsWith("[")) {
    host = rawHost.slice(NEXT_CHARACTER_OFFSET, LAST_INDEX);
  }
  return {
    host,
    port: Number(bind.slice(separator + NEXT_CHARACTER_OFFSET)),
  };
};

const sendEmpty = (response: ServerResponse, status: number): void => {
  response.statusCode = status;
  response.setHeader("Content-Length", "0");
  response.end();
};

const notFoundRequest: RequestListener = (_request, response) => {
  sendEmpty(response, HTTP_NOT_FOUND);
};

const makeReadinessProbe = (
  database: Database["Service"],
  getPrevious: () => boolean | undefined,
  setPrevious: (ready: boolean) => void,
) =>
  database.checkReadiness.pipe(
    Effect.tap((ready) =>
      Effect.suspend(() => {
        if (getPrevious() === ready) {
          return Effect.void;
        }
        setPrevious(ready);
        return Effect.log("database.readiness_changed");
      }),
    ),
  );

const openListener = (
  bind: string,
  listener: (request: IncomingMessage, response: ServerResponse) => void,
) =>
  Effect.callback<Server, ServerBindFailure>((resume) => {
    const server = createServer(listener);
    const cleanup = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
    };
    const onError = (): void => {
      cleanup();
      resume(Effect.fail(new ServerBindError({})));
    };
    const onListening = (): void => {
      cleanup();
      resume(Effect.succeed(server));
    };

    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(parseBind(bind));
    } catch {
      onError();
    }

    return Effect.sync(() => {
      cleanup();
      server.closeAllConnections();
      if (server.listening) {
        server.close();
      }
    });
  });
const closeServer = (server: Server): Promise<void> => {
  const closing = server[Symbol.asyncDispose]();
  server.closeIdleConnections();
  return closing;
};

const forceClose = (
  server: Server,
  requests: ReadonlySet<Fiber.Fiber<unknown, unknown>>,
  awaitClose: Effect.Effect<void, ShutdownFailure>,
) =>
  Fiber.interruptAll(requests).pipe(
    Effect.andThen(
      Effect.sync(() => {
        server.closeAllConnections();
      }),
    ),
    Effect.andThen(awaitClose),
  );

const closeListener = (
  server: Server,
  accepting: AcceptingState,
  requests: ReadonlySet<Fiber.Fiber<unknown, unknown>>,
) =>
  Effect.gen(function* closeHttpListener() {
    accepting.value = false;
    yield* Effect.log("server.stopping");
    const closePromise = yield* Effect.try({
      catch: () => new ShutdownError(undefined),
      try: () => closeServer(server),
    });
    const awaitClose = Effect.tryPromise({
      catch: () => new ShutdownError(undefined),
      try: () => closePromise,
    });
    const closedGracefully = yield* Effect.raceFirst(
      awaitClose.pipe(Effect.as(true)),
      Effect.sleep(SHUTDOWN_TIMEOUT).pipe(Effect.as(false)),
    );

    if (!closedGracefully) {
      yield* forceClose(server, requests, awaitClose);
    }
    yield* Fiber.awaitAll(requests);
  });

type RunRequest = (effect: Effect.Effect<HealthStatus>) => Fiber.Fiber<unknown, unknown>;

const makeRequestRuntime = Effect.gen(function* makeRequestRuntimeBridge() {
  const database = yield* Database;
  const loggers = yield* Effect.service(Logger.CurrentLoggers);
  const minimumLogLevel = yield* References.MinimumLogLevel;
  const requestLayer = Layer.mergeAll(
    Layer.succeed(Database, database),
    Layer.succeed(Logger.CurrentLoggers, loggers),
    Layer.succeed(References.MinimumLogLevel, minimumLogLevel),
  );
  const requestRuntime = ManagedRuntime.make(requestLayer);
  yield* Effect.addFinalizer(() => requestRuntime.disposeEffect);
  yield* Effect.promise(() => requestRuntime.runPromise(Database));
  return { database, requestRuntime };
});

interface RequestListenerOptions {
  readonly accepting: AcceptingState;
  readonly readinessProbe: Effect.Effect<boolean>;
  readonly requests: Set<Fiber.Fiber<unknown, unknown>>;
  readonly runRequest: RunRequest;
  readonly unmatchedRequest: RequestListener;
}

const makeRequestListener =
  ({ accepting, readinessProbe, requests, runRequest, unmatchedRequest }: RequestListenerOptions) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    const target = request.url;
    if (request.method !== "GET" || (target !== "/health/live" && target !== "/health/ready")) {
      unmatchedRequest(request, response);
      return;
    }
    const effect = healthStatus({
      accepting: accepting.value,
      checkReadiness: readinessProbe,
      target,
    }).pipe(
      Effect.tap((status) =>
        Effect.sync(() => {
          sendEmpty(response, status);
        }),
      ),
    );
    const fiber = runRequest(effect);
    requests.add(fiber);
    fiber.addObserver((exit) => {
      requests.delete(fiber);
      if (Exit.isFailure(exit) && !response.writableEnded) {
        response.destroy();
      }
    });
  };

const makeServer = (unmatchedRequest: RequestListener) =>
  Effect.gen(function* makeHttpServer() {
    const config = yield* Config;
    const bridge = yield* makeRequestRuntime;
    const accepting: AcceptingState = { value: true };
    const requests = new Set<Fiber.Fiber<unknown, unknown>>();
    const readinessState: { previous?: boolean } = {};
    const readinessProbe = makeReadinessProbe(
      bridge.database,
      () => readinessState.previous,
      (ready) => {
        readinessState.previous = ready;
      },
    );
    const listener = makeRequestListener({
      accepting,
      readinessProbe,
      requests,
      runRequest: (effect) => bridge.requestRuntime.runFork(effect),
      unmatchedRequest,
    });
    const server = yield* Effect.acquireRelease(
      openListener(config.server.bind, listener),
      (acquired) => closeListener(acquired, accepting, requests).pipe(Effect.orDie),
    );
    void server;
    return HttpServer.of({ listening: true });
  });

class HttpServer extends contextService<HttpServer, HttpServerService>()(
  "@nama/server/HttpServer",
) {
  static readonly layer = (unmatchedRequest: RequestListener = notFoundRequest) =>
    Layer.effect(HttpServer, makeServer(unmatchedRequest));
}

export { HttpServer };
