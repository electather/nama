// oxlint-disable eslint/max-lines-per-function, eslint/max-params, eslint/max-statements, eslint/no-magic-numbers, promise/avoid-new, promise/prefer-await-to-callbacks, typescript/no-unsafe-type-assertion, unicorn/max-nested-calls -- The real subprocess and controlled HTTP exchange keep launch, socket, fetch, deadline, and cleanup boundaries observable.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { PluginConnectionStatus, PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { Effect } from "effect";

import { PluginSupervisor } from "../../src/plugin/supervisor.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const CALL_DEADLINE_MILLISECONDS = 2000;
const API_KEY = "jellyfin-api-key-sentinel";
const SERVER_ID = "server-identity";
const USER_ID = "user-identity";

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
      const address = server.address() as AddressInfo;
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
  baseUrl: string,
  userId: string = USER_ID,
  deadlineMilliseconds: number = CALL_DEADLINE_MILLISECONDS,
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
          capabilities: [],
          remoteName: "Living Room",
          remoteVersion: "10.11.0",
          status: PluginConnectionStatus.CONNECTED,
        });
        expect(response.connection?.providerUserReference).toMatch(/^jellyfin\/v1:/u);
        expect(response.connection?.providerUserReference).not.toContain(SERVER_ID);
        expect(response.connection?.providerUserReference).not.toContain(USER_ID);
        expect(jellyfin.requests).toEqual([
          { authorization: undefined, url: "/jellyfin/System/Info/Public" },
          {
            authorization: `MediaBrowser Token="${API_KEY}"`,
            url: `/jellyfin/Users/${USER_ID}`,
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
        const mappedLoopback = yield* candidateConnection(
          supervisor,
          jellyfin.baseUrl.replace("127.0.0.1", "[::ffff:127.0.0.1]"),
        );
        expect(mappedLoopback.connection?.status).toBe(PluginConnectionStatus.CONNECTED);
        const mappedRequestCount = jellyfin.requests.length;

        const publicDestination = yield* candidateConnection(
          supervisor,
          "https://public.example.test",
        );
        expect(publicDestination.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(jellyfin.requests).toHaveLength(mappedRequestCount);
        for (const unsafeBaseUrl of [
          `${jellyfin.origin}/first/second`,
          `${jellyfin.origin}/jellyfin?credential=unsafe`,
          `${jellyfin.origin}/jellyfin#fragment`,
          jellyfin.origin.replace("http://", "http://embedded@"),
        ]) {
          const unsafe = yield* candidateConnection(supervisor, unsafeBaseUrl);
          expect(unsafe.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        }
        expect(jellyfin.requests).toHaveLength(mappedRequestCount);

        const redirect = yield* candidateConnection(supervisor, `${jellyfin.origin}/redirect`);
        expect(redirect.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);
        expect(jellyfin.requests.at(-1)).toEqual({
          authorization: undefined,
          url: "/redirect/System/Info/Public",
        });

        const disabled = yield* candidateConnection(supervisor, `${jellyfin.origin}/disabled`);
        expect(disabled.connection?.status).toBe(PluginConnectionStatus.INCOMPATIBLE);

        const deadlineFailure = yield* candidateConnection(
          supervisor,
          `${jellyfin.origin}/hanging`,
          USER_ID,
          50,
        ).pipe(Effect.flip);
        expect(deadlineFailure).toMatchObject({ _tag: "PluginDeadlineExceeded" });
      }).pipe(Effect.provide(PluginSupervisor.layer())),
    ),
  10_000,
);
