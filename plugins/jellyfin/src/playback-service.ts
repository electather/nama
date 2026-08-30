import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { PlaybackService } from "@nama/api/nama/plugin/v1/playback_pb.js";

import { requireJellyfinExtensionPlayback } from "./connection.ts";
import {
  closeJellyfinPlayback,
  openJellyfinPlayback,
  planJellyfinPlayback,
  reportJellyfinPlayback,
} from "./extension-playback.ts";
import type { LaunchDocument, ProviderLaunchDocument } from "./launch-document.ts";

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

const requireInstanceLaunch = (launch: LaunchDocument): ProviderLaunchDocument => {
  if (launch.kind !== "instance") {
    throw new ConnectError("playback unavailable", Code.Unimplemented);
  }
  return launch;
};

const requireCompatibleInstance = async (launch: LaunchDocument, signal: AbortSignal) => {
  const instance = requireInstanceLaunch(launch);
  await requireJellyfinExtensionPlayback(
    {
      apiKey: instance.credentials.api_key,
      baseUrl: instance.configuration.base_url,
    },
    signal,
  );
  return instance;
};

const registerJellyfinPlaybackService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.service(PlaybackService, {
    closePlayback: async (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return closeJellyfinPlayback(
        await requireCompatibleInstance(launch, context.signal),
        request,
        context.signal,
      );
    },
    openPlayback: async (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return openJellyfinPlayback(
        await requireCompatibleInstance(launch, context.signal),
        request,
        context.signal,
      );
    },
    planPlayback: async (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return planJellyfinPlayback(
        await requireCompatibleInstance(launch, context.signal),
        request,
        context.signal,
      );
    },
    reportPlayback: async (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return reportJellyfinPlayback(
        await requireCompatibleInstance(launch, context.signal),
        request,
        context.signal,
      );
    },
  });
};

export { registerJellyfinPlaybackService };
