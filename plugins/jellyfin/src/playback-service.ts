import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { PlaybackService } from "@nama/api/nama/plugin/v1/playback_pb.js";

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

const registerJellyfinPlaybackService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.service(PlaybackService, {
    closePlayback: (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return closeJellyfinPlayback(requireInstanceLaunch(launch), request, context.signal);
    },
    openPlayback: (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return openJellyfinPlayback(requireInstanceLaunch(launch), request, context.signal);
    },
    planPlayback: (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return planJellyfinPlayback(requireInstanceLaunch(launch), request, context.signal);
    },
    reportPlayback: (request, context) => {
      requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
      return reportJellyfinPlayback(requireInstanceLaunch(launch), request, context.signal);
    },
  });
};

export { registerJellyfinPlaybackService };
