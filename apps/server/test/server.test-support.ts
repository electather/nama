import { once } from "node:events";
import type { RequestListener } from "node:http";
import type { Socket } from "node:net";
import { connect } from "node:net";

import { Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";

import { Config } from "../src/config.ts";
import { Database } from "../src/database.ts";
import { HttpServer } from "../src/server.ts";
import { HOST, reservePort } from "./network.test-support.ts";

const SINGLE_CONNECTION = 1;
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const SHORT_DELAY_MILLISECONDS = 25;
const EXPECTED_READINESS_TRANSITIONS = 2;

interface CapturedSocket {
  readonly location: URL;
  readonly read: () => string;
  readonly socket: Socket;
}

const serverConfig = (port: number) =>
  Config.of({
    database: Object.freeze({
      maxConnections: SINGLE_CONNECTION,
      url: Redacted.make("postgres://unused"),
    }),
    logging: Object.freeze({ level: "info" as const }),
    security: Object.freeze({ masterKey: Redacted.make("unused") }),
    server: Object.freeze({
      bind: `${HOST}:${port}`,
      publicUrl: `http://${HOST}:${port}/`,
    }),
  });

const messageText = (message: unknown): string => {
  if (Array.isArray(message)) {
    const parts = message.map(String);
    return parts.join(" ");
  }
  return String(message);
};

interface ServerLayerOptions {
  readonly messages?: string[];
  readonly unmatchedRequest?: RequestListener | undefined;
}

const serverLayerWithDatabase = (
  port: number,
  databaseLayer: Layer.Layer<Database>,
  options: ServerLayerOptions = {},
) => {
  const messages = options.messages ?? [];
  const capture = Logger.make<unknown, void>(({ message }) => {
    messages.push(messageText(message));
  });
  const dependencies = Layer.mergeAll(
    Layer.succeed(Config, serverConfig(port)),
    databaseLayer,
    Logger.layer([capture]),
  );
  return HttpServer.layer(options.unmatchedRequest).pipe(Layer.provide(dependencies));
};

const serverLayer = (
  port: number,
  database: Database["Service"],
  options: ServerLayerOptions = {},
) => serverLayerWithDatabase(port, Layer.succeed(Database, database), options);

const startServer = (
  database: Database["Service"],
  messages: string[] = [],
  unmatchedRequest?: RequestListener,
) =>
  Effect.gen(function* startedServer() {
    const port = yield* reservePort;
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    yield* Layer.buildWithScope(serverLayer(port, database, { messages, unmatchedRequest }), scope);
    return {
      close: Scope.close(scope, Exit.void),
      origin: `http://${HOST}:${port}`,
    };
  });

const openCapturedSocket = (origin: string) =>
  Effect.gen(function* capturedSocket() {
    const location = new URL(origin);
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => connect(Number(location.port), location.hostname)),
      (acquired) =>
        Effect.sync(() => {
          acquired.destroy();
        }),
    );
    socket.setEncoding("utf8");
    let received = "";
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    yield* Effect.promise(() => once(socket, "connect"));
    return { location, read: () => received, socket };
  });

const sendReadyRequest = (client: CapturedSocket, connection: "close" | "keep-alive") =>
  Effect.sync(() => {
    client.socket.write(
      `GET /health/ready HTTP/1.1\r\nHost: ${client.location.host}\r\nConnection: ${connection}\r\n\r\n`,
    );
  });

const statusesFrom = (received: string): (string | undefined)[] =>
  [...received.matchAll(/HTTP\/1\.1 (?<status>\d{3})/gu)].map((match) => match.groups?.["status"]);

const waitForShortDelay = Effect.sleep(SHORT_DELAY_MILLISECONDS);

const waitForSocketClose = (client: CapturedSocket) =>
  Effect.promise(() => once(client.socket, "close"));

export {
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
};
export type { CapturedSocket, ServerLayerOptions };
