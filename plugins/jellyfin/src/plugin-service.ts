import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";

import { getJellyfinConnection } from "./connection.ts";
import { jellyfinPluginInfo } from "./info.ts";
import type { LaunchDocument } from "./launch-document.ts";

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

const registerJellyfinPluginService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.service(PluginService, {
    getConnection: async (_request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      if (launch.kind === "discovery") {
        throw new ConnectError("connection unavailable", Code.Unimplemented);
      }
      return {
        connection: await getJellyfinConnection(
          {
            apiKey: launch.credentials.api_key,
            baseUrl: launch.configuration.base_url,
            userId: launch.configuration.user_id,
          },
          context.signal,
        ),
      };
    },
    getInfo: (_request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return { pluginInfo: jellyfinPluginInfo };
    },
  });
};

export { registerJellyfinPluginService };
