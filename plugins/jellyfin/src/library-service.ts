import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";

import type { LaunchDocument, ProviderLaunchDocument } from "./launch-document.ts";
import { normalizeJellyfinItem } from "./media-item.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinJsonResponse } from "./request.ts";
import { hasMaximumCodePointLength } from "./value.ts";

const EMPTY_LENGTH = 0;
const MAXIMUM_ITEM_REFERENCE_CODE_POINTS = 256;
const MAXIMUM_MEDIA_RESPONSE_BYTES = 1_048_576;

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

const itemFromResponse = (response: JellyfinJsonResponse, itemId: string) => {
  if (response.kind === "success") {
    return normalizeJellyfinItem(response.body, itemId);
  }
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw new ConnectError("Jellyfin item is forbidden", Code.PermissionDenied);
  }
  if (response.kind === "not_found") {
    throw new ConnectError("Jellyfin item was not found", Code.NotFound);
  }
  if (response.kind === "unreachable") {
    throw new ConnectError("Jellyfin server is unavailable", Code.Unavailable);
  }
  throw new ConnectError("Jellyfin media response is invalid", Code.Internal);
};

const readJellyfinItem = async (
  launch: ProviderLaunchDocument,
  itemId: string,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  const response = await request.requestJson(["Items", itemId], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
    query: { userId: launch.configuration.user_id },
    signal,
  });
  return itemFromResponse(response, itemId);
};

const registerJellyfinLibraryService = (
  router: ConnectRouter,
  launch: LaunchDocument,
  requireAuthorization: RequireAuthorization,
): void => {
  router.rpc(LibraryService.method.getItem, async (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("library unavailable", Code.Unimplemented);
    }
    const itemId = request.itemReference?.itemId;
    if (
      itemId === undefined ||
      itemId.length === EMPTY_LENGTH ||
      !hasMaximumCodePointLength(itemId, MAXIMUM_ITEM_REFERENCE_CODE_POINTS)
    ) {
      throw new ConnectError("item reference is invalid", Code.InvalidArgument);
    }
    return { item: await readJellyfinItem(launch, itemId, context.signal) };
  });
};

export { registerJellyfinLibraryService };
