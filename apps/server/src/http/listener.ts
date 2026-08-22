import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { Data, Effect } from "effect";

const SHUTDOWN_TIMEOUT = 10_000;
const FIRST_INDEX = 0;
const NEXT_CHARACTER_OFFSET = 1;
const LAST_INDEX = -1;

const taggedError = Data.TaggedError;
const ServerBindError = taggedError("ServerBindError");
const ShutdownError = taggedError("ShutdownError");
type ServerBindFailure = InstanceType<typeof ServerBindError>;
type ShutdownFailure = InstanceType<typeof ShutdownError>;

interface ListenerShutdown {
  readonly awaitRequests: Effect.Effect<void>;
  readonly emitStopping: () => Effect.Effect<void>;
  readonly interruptRequests: Effect.Effect<void>;
  readonly markNotAccepting: () => void;
}

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
  interruptRequests: Effect.Effect<void>,
  awaitClose: Effect.Effect<void, ShutdownFailure>,
) =>
  interruptRequests.pipe(
    Effect.andThen(
      Effect.sync(() => {
        server.closeAllConnections();
      }),
    ),
    Effect.andThen(awaitClose),
  );

const closeListener = (server: Server, shutdown: ListenerShutdown) =>
  Effect.gen(function* closeHttpListener() {
    shutdown.markNotAccepting();
    yield* shutdown.emitStopping();
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
      yield* forceClose(server, shutdown.interruptRequests, awaitClose);
    }
    yield* shutdown.awaitRequests;
  });

export { ShutdownError, closeListener, openListener, sendEmpty };
export type { ListenerShutdown };
