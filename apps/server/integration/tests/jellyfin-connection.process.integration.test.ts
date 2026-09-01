// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, promise/avoid-new, promise/prefer-await-to-callbacks, unicorn/max-nested-calls -- The real subprocess and controlled HTTP exchange keep launch, socket, fetch, deadline, and cleanup boundaries observable.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import {
  PluginConnectionStatus,
  PluginService,
  ProviderCapability,
} from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect, Redacted } from "effect";

import { Config } from "../../src/config/config.ts";
import { configuredLoggingLayer } from "../../src/logging/logging.ts";
import { PluginSupervisor } from "../../src/plugin/supervisor.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 2000;
const API_KEY = "jellyfin-api-key-sentinel";
const SERVER_ID = "server-identity";
const USER_ID = "user-identity";
const EXPECTED_PROVIDER_PRINCIPAL = "jellyfin/v1:Ej5xNxA0d3a8BvpvknVkz-AYMPOYZucu9u3Z-bL0PAI";
const MALFORMED_RESPONSE_SENTINEL = "malformed-jellyfin-response-sentinel";
const OVERSIZED_RESPONSE_SENTINEL = "oversized-jellyfin-response-sentinel";
const HOSTILE_RESPONSE_SENTINEL = "hostile-jellyfin-response-sentinel";
const loggingConfig = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("unused") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("unused") }),
  server: Object.freeze({
    bind: "127.0.0.1:8080",
    lanDiscovery: false,
    publicUrl: "http://127.0.0.1:8080/",
  }),
});

const OVERSIZED_RESPONSE_BODY = JSON.stringify({
  Id: SERVER_ID,
  Padding: `${OVERSIZED_RESPONSE_SENTINEL}:${"x".repeat(131_072)}`,
  ServerName: "Living Room",
  Version: "10.11.0",
});

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly url: string;
}

interface ControlledJellyfin {
  readonly baseUrl: string;
  readonly origin: string;
  readonly requests: ObservedRequest[];
  readonly server: Server;
}

const respondJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};

const respondRaw = (response: ServerResponse, statusCode: number, body: string): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(body);
};

const acquireControlledJellyfin = Effect.acquireRelease(
  Effect.tryPromise({
    catch: (error) => error,
    try: async (): Promise<ControlledJellyfin> => {
      const requests: ObservedRequest[] = [];
      const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        requests.push({ authorization: request.headers.authorization, url: request.url ?? "" });
        if (request.url === "/redirect/System/Info/Public") {
          response.statusCode = 302;
          response.setHeader("location", "http://public.example.test/");
          response.end();
          return;
        }
        if (request.url === "/hanging/System/Info/Public") {
          return;
        }
        if (request.url === "/malformed/System/Info/Public") {
          respondRaw(response, 200, `{${MALFORMED_RESPONSE_SENTINEL}`);
          return;
        }
        if (request.url === "/oversized/System/Info/Public") {
          respondRaw(response, 200, OVERSIZED_RESPONSE_BODY);
          return;
        }
        if (request.url === "/hostile/System/Info/Public") {
          respondRaw(response, 503, `${HOSTILE_RESPONSE_SENTINEL}:MediaBrowser Token="${API_KEY}"`);
          return;
        }
        if (request.url === "/hostile-user/System/Info/Public") {
          respondJson(response, {
            Id: SERVER_ID,
            ServerName: "Living Room",
            Version: "10.11.0",
          });
          return;
        }
        if (
          request.url === `/hostile-user/Users/${USER_ID}` &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondRaw(response, 503, `${HOSTILE_RESPONSE_SENTINEL}:MediaBrowser Token="${API_KEY}"`);
          return;
        }
        if (
          request.url === "/jellyfin/System/Info/Public" ||
          request.url === "/disabled/System/Info/Public"
        ) {
          respondJson(response, {
            Id: SERVER_ID,
            ServerName: "Living Room",
            Version: "10.11.0",
          });
          return;
        }
        if (
          (request.url === `/jellyfin/Users/${USER_ID}` ||
            request.url === `/disabled/Users/${USER_ID}`) &&
          request.headers.authorization === `MediaBrowser Token="${API_KEY}"`
        ) {
          respondJson(response, {
            Id: USER_ID,
            Policy: { IsDisabled: request.url.startsWith("/disabled/") },
            ServerId: SERVER_ID,
          });
          return;
        }
        response.statusCode = 404;
        response.end();
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Controlled Jellyfin server did not bind to a TCP address");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      return {
        baseUrl: `${origin}/jellyfin`,
        origin,
        requests,
        server,
      };
    },
  }),
  ({ server }) =>
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        }),
    ),
);
const candidateConnection = (
  supervisor: PluginSupervisor["Service"],
  {
    baseUrl,
    userId = USER_ID,
    deadlineMilliseconds = CALL_DEADLINE_MILLISECONDS,
  }: {
    readonly baseUrl: string;
    readonly deadlineMilliseconds?: number;
    readonly userId?: string;
  },
) =>
  Effect.scoped(
    supervisor
      .supervise(
        {
          arguments: [JELLYFIN_PLUGIN_PATH],
          executable: process.execPath,
          expectedProviderType: "jellyfin",
          stderrEvents: [],
        },
        {
          configuration: { base_url: baseUrl, user_id: userId },
          credentials: { api_key: API_KEY },
          kind: "candidate",
        },
      )
      .pipe(
        Effect.flatMap((plugin) =>
          plugin.call(PluginService.method.getConnection, {}, deadlineMilliseconds),
        ),
      ),
  );

it.live(
  "verifies the configured Jellyfin server and explicit user through a one-shot candidate",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinCandidateConnectionTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const plugin = yield* supervisor.supervise(
          {
            arguments: [JELLYFIN_PLUGIN_PATH],
            executable: process.execPath,
            expectedProviderType: "jellyfin",
            stderrEvents: [],
          },
          {
            configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
            credentials: { api_key: API_KEY },
            kind: "candidate",
          },
        );

        const response = yield* plugin.call(
          PluginService.method.getConnection,
          {},
          CALL_DEADLINE_MILLISECONDS,
        );

        expect(response.connection).toMatchObject({
          capabilities: [
            ProviderCapability.LIBRARY_READ,
            ProviderCapability.ARTWORK_RESOLVE,
            ProviderCapability.WATCH_STATE_READ,
            ProviderCapability.WATCHED_WRITE,
          ],
          remoteName: "Living Room",
          remoteVersion: "10.11.0",
          status: PluginConnectionStatus.CONNECTED,
        });
        expect(response.connection?.providerUserReference).toBe(EXPECTED_PROVIDER_PRINCIPAL);
        expect(response.connection?.providerUserReference).not.toContain(SERVER_ID);
        expect(response.connection?.providerUserReference).not.toContain(USER_ID);
        expect(jellyfin.requests).toEqual([
          { authorization: undefined, url: "/jellyfin/System/Info/Public" },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            url: `/jellyfin/Users/${USER_ID}`,
          },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            url: "/jellyfin/Nama/v1/handshake",
          },
        ]);
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  10_000,
);

it.live(
  "rejects unsafe redirects and identities while honoring candidate deadlines",
  () =>
    Effect.scoped(
      Effect.gen(function* jellyfinCandidateFailureTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const mappedLoopback = yield* candidateConnection(supervisor, {
          baseUrl: jellyfin.baseUrl.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
        });
        expect(mappedLoopback.connection?.status).toBe(PluginConnectionStatus.CONNECTED);
        const mappedRequestCount = jellyfin.requests.length;

        const publicDestination = yield* candidateConnection(supervisor, {
          baseUrl: "http://public.example.test",
        });
        expect(publicDestination.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(jellyfin.requests).toHaveLength(mappedRequestCount);
        for (const unsafeBaseUrl of [
          `${jellyfin.origin}/first/second`,
          `${jellyfin.origin}/jellyfin?credential=unsafe`,
          `${jellyfin.origin}/jellyfin#fragment`,
          jellyfin.origin.replace("http://", "http://embedded@"),
        ]) {
          const unsafe = yield* candidateConnection(supervisor, { baseUrl: unsafeBaseUrl });
          expect(unsafe.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        }
        expect(jellyfin.requests).toHaveLength(mappedRequestCount);

        const redirect = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/redirect`,
        });
        expect(redirect.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(jellyfin.requests.at(-1)).toEqual({
          authorization: undefined,
          url: "/redirect/System/Info/Public",
        });

        const disabled = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/disabled`,
        });
        expect(disabled.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);

        const authenticationFailure = yield* candidateConnection(supervisor, {
          baseUrl: jellyfin.baseUrl,
          userId: "missing-user",
        });
        expect(authenticationFailure.connection?.status).toBe(
          PluginConnectionStatus.AUTHENTICATION_FAILED,
        );

        const deadlineFailure = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/hanging`,
          deadlineMilliseconds: 50,
        }).pipe(Effect.flip);
        expect(deadlineFailure).toMatchObject({ _tag: "PluginDeadlineExceeded" });
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  10_000,
);

it.live(
  "bounds hostile Jellyfin responses and keeps their contents out of process results and output",
  () => {
    const lines: string[] = [];
    return Effect.scoped(
      Effect.gen(function* hostileJellyfinResponseTest() {
        const jellyfin = yield* acquireControlledJellyfin;
        const supervisor = yield* PluginSupervisor;
        const malformed = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/malformed`,
        });
        const oversized = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/oversized`,
        });
        const hostile = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/hostile`,
        });
        const hostileUser = yield* candidateConnection(supervisor, {
          baseUrl: `${jellyfin.origin}/hostile-user`,
        });

        expect(malformed.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(oversized.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(hostile.connection?.status).toBe(PluginConnectionStatus.UNREACHABLE);
        expect(hostileUser.connection?.status).toBe(PluginConnectionStatus.UNREACHABLE);
        expect(jellyfin.requests.at(-1)).toEqual({
          authorization: `MediaBrowser Token="${API_KEY}"`,
          url: `/hostile-user/Users/${USER_ID}`,
        });

        const returned = JSON.stringify([malformed, oversized, hostile, hostileUser]);
        const output = lines.join("");
        for (const privateValue of [
          API_KEY,
          MALFORMED_RESPONSE_SENTINEL,
          OVERSIZED_RESPONSE_SENTINEL,
          HOSTILE_RESPONSE_SENTINEL,
        ]) {
          expect(returned).not.toContain(privateValue);
          expect(output).not.toContain(privateValue);
        }
      }).pipe(
        Effect.provide(PluginSupervisor.layer()),
        Effect.provide(
          configuredLoggingLayer(loggingConfig, (line) => {
            lines.push(line);
          }),
        ),
      ),
    );
  },
  10_000,
);
