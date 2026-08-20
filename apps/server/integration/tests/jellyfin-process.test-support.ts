import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";

import { Effect } from "effect";

import type { PluginSupervisor } from "../../src/plugin/supervisor.ts";

const JELLYFIN_PLUGIN_PATH = join(import.meta.dirname, "../../../../plugins/jellyfin/src/main.ts");
const EPHEMERAL_PORT = 0;
const HTTP_OK = 200;
const API_KEY = "jellyfin-api-key-sentinel";
const USER_ID = "user-identity";

interface ObservedRequest {
  readonly authorization: string | undefined;
  readonly method: string | undefined;
  readonly url: string;
}
interface ControlledJellyfin {
  readonly baseUrl: string;
  readonly requests: ObservedRequest[];
  readonly server: Server;
}
type ControlledHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  observation: ObservedRequest,
) => void;

const respondJson = (response: ServerResponse, value: unknown): void => {
  response.statusCode = HTTP_OK;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
};
const respondRaw = (response: ServerResponse, statusCode: number, body: string): void => {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(body);
};

const controlledJellyfin = (handler: ControlledHandler) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: (error) => error,
      try: async (): Promise<ControlledJellyfin> => {
        const requests: ObservedRequest[] = [];
        const server = createServer((request, response) => {
          const observation = {
            authorization: request.headers.authorization,
            method: request.method,
            url: request.url ?? "",
          };
          requests.push(observation);
          handler(request, response, observation);
        });
        server.listen(EPHEMERAL_PORT, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (address === null || typeof address === "string") {
          throw new Error("Controlled Jellyfin server did not bind to a TCP address");
        }
        return {
          baseUrl: `http://127.0.0.1:${address.port}/jellyfin`,
          requests,
          server,
        };
      },
    }),
    ({ server }) => Effect.promise(() => server[Symbol.asyncDispose]()),
  );

const superviseJellyfin = (supervisor: PluginSupervisor["Service"], jellyfin: ControlledJellyfin) =>
  supervisor.supervise(
    {
      arguments: [JELLYFIN_PLUGIN_PATH],
      executable: process.execPath,
      expectedProviderType: "jellyfin",
      stderrEvents: [],
    },
    {
      configuration: { base_url: jellyfin.baseUrl, user_id: USER_ID },
      credentials: { api_key: API_KEY },
      kind: "instance",
      providerInstanceId: "provider-instance",
      revision: "revision-1",
    },
  );

export { API_KEY, USER_ID, controlledJellyfin, respondJson, respondRaw, superviseJellyfin };
export type { ControlledHandler, ControlledJellyfin, ObservedRequest };
