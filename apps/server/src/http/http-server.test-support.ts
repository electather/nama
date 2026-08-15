import type { RequestListener } from "node:http";

import { Effect, Exit, Layer, Logger, Redacted, Scope } from "effect";

import { Config } from "../config/config.ts";
import { Database } from "../database/database.ts";
import { HttpServer } from "./http-server.ts";
import { HOST, reservePort } from "./network.test-support.ts";

const SINGLE_CONNECTION = 1;

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

export { SINGLE_CONNECTION, serverLayer, serverLayerWithDatabase, startServer };
export type { ServerLayerOptions };
