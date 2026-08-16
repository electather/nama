import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Redacted } from "effect";

import { runConfigured } from "../app.ts";
import { Config } from "../config/config.ts";
import { HttpServer } from "../http/http-server.ts";
import { makeBootstrapToken, BootstrapToken } from "../setup/bootstrap-token.ts";

const TOKEN_BYTES = 32;
const STARTED_AT = 0;
const SINGLE_RECORD_COUNT = 1;
const FIRST_RECORD_INDEX = 0;

const failingRuntimeLayer = (onRelease: () => void) => {
  const bootstrapToken = makeBootstrapToken("setup-eligible", {
    randomBytes: () => Buffer.alloc(TOKEN_BYTES),
    writeLine: () => {
      throw new Error("raw-output-failure");
    },
  });
  const httpServer = HttpServer.of({ listening: true });
  const acquireHttpServer = Effect.succeed(httpServer);
  const httpServerLayer = Layer.effect(
    HttpServer,
    Effect.acquireRelease(acquireHttpServer, () => Effect.sync(onRelease)),
  );
  return Layer.mergeAll(
    Layer.succeed(BootstrapToken, BootstrapToken.of(bootstrapToken)),
    httpServerLayer,
  );
};

const config = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("postgres://secret") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("master-secret") }),
  server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://127.0.0.1:8080/" }),
});

it.effect("emits only one tagged startup failure after bootstrap activation fails", () =>
  Effect.gen(function* bootstrapActivationFailureTest() {
    const lines: string[] = [];
    let released = false;
    const runtimeLayer = failingRuntimeLayer(() => {
      released = true;
    });

    const exit = yield* Effect.exit(
      runConfigured({
        config,
        migrationsFolder: "unused",
        serverRuntimeLayer: runtimeLayer,
        startedAt: STARTED_AT,
        writeLogLine: (line) => {
          lines.push(line);
        },
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(released).toBe(true);
    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    const record: unknown = JSON.parse(lines[FIRST_RECORD_INDEX] ?? "");
    expect(record).toMatchObject({
      error_tag: "BootstrapTokenInitializationError",
      event: "server.start_failed",
    });
  }),
);
