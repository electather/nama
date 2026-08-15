import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { Config } from "../src/config/config.ts";
import { Database } from "../src/database/database.ts";
import { HttpServer } from "../src/http/http-server.ts";

const FAILURE_MIGRATIONS = `${import.meta.dirname}/fixtures/migrations/failure/`;

const configLayer = Config.layer(process.env).pipe(Layer.provide(NodeFileSystem.layer));
const databaseLayer = Database.layer(FAILURE_MIGRATIONS).pipe(Layer.provide(configLayer));
const serverLayer = HttpServer.layer().pipe(
  Layer.provide(Layer.mergeAll(configLayer, databaseLayer)),
);
const app = HttpServer.pipe(Effect.provide(serverLayer));
const migrationFailureMainModule = import.meta.filename;

if (import.meta.main) {
  NodeRuntime.runMain(app, { disableErrorReporting: true });
}

export { migrationFailureMainModule };
