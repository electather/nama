import type { ConnectRouter } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ProviderArtworkReference } from "@nama/api/nama/plugin/v1/common_pb.js";
import { ArtworkAuthorizationScope, LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";

import { decodeArtworkReference } from "./artwork-reference.ts";
import type { JellyfinArtworkReference } from "./artwork-reference.ts";
import type { LaunchDocument, ProviderLaunchDocument } from "./launch-document.ts";
import { normalizeJellyfinItem } from "./media-item.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinArtworkProbeResponse, JellyfinJsonResponse } from "./request.ts";
import { hasMaximumCodePointLength } from "./value.ts";

const EMPTY_LENGTH = 0;
const NO_DIMENSION_PREFERENCE = 0;
const MINIMUM_JELLYFIN_DIMENSION = 1;
const MAXIMUM_ITEM_REFERENCE_CODE_POINTS = 256;
const MAXIMUM_MEDIA_RESPONSE_BYTES = 1_048_576;
const MAXIMUM_JELLYFIN_DIMENSION = 2_147_483_647;

type RequireAuthorization = (authorization: string | null, bearer: string) => void;

interface ArtworkResolutionRequest {
  readonly itemId: string;
  readonly maxHeight: number | undefined;
  readonly maxWidth: number | undefined;
  readonly reference: JellyfinArtworkReference;
  readonly signal: AbortSignal;
}

const decodedArtworkRequest = (artworkReference: ProviderArtworkReference | undefined) => {
  const itemId = artworkReference?.itemReference?.itemId;
  const artworkId = artworkReference?.artworkId;
  if (
    itemId === undefined ||
    itemId.length === EMPTY_LENGTH ||
    itemId === "." ||
    itemId === ".." ||
    !hasMaximumCodePointLength(itemId, MAXIMUM_ITEM_REFERENCE_CODE_POINTS) ||
    artworkId === undefined
  ) {
    throw new ConnectError("artwork reference is invalid", Code.InvalidArgument);
  }
  const reference = decodeArtworkReference(artworkId);
  if (reference === undefined) {
    throw new ConnectError("artwork reference is invalid", Code.InvalidArgument);
  }
  return { itemId, reference };
};

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

const jellyfinRequestForLaunch = (launch: ProviderLaunchDocument) => {
  const request = createJellyfinRequest({
    apiKey: launch.credentials.api_key,
    baseUrl: launch.configuration.base_url,
  });
  if (request === undefined) {
    throw new ConnectError("Jellyfin adapter is unavailable", Code.Internal);
  }
  return request;
};

const readJellyfinItem = async (
  launch: ProviderLaunchDocument,
  itemId: string,
  signal: AbortSignal,
) => {
  const request = jellyfinRequestForLaunch(launch);
  const response = await request.requestJson(["Items", itemId], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_MEDIA_RESPONSE_BYTES,
    query: { userId: launch.configuration.user_id },
    signal,
  });
  return itemFromResponse(response, itemId);
};

const requestedDimension = (value: number | undefined): string | undefined => {
  if (value === undefined || value === NO_DIMENSION_PREFERENCE) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_JELLYFIN_DIMENSION ||
    value > MAXIMUM_JELLYFIN_DIMENSION
  ) {
    throw new ConnectError("artwork dimensions are invalid", Code.InvalidArgument);
  }
  return String(value);
};

const artworkQuery = (
  reference: JellyfinArtworkReference,
  maxWidth: number | undefined,
  maxHeight: number | undefined,
): Readonly<Record<string, string>> => {
  const query: Record<string, string> = { tag: reference.cacheTag };
  const width = requestedDimension(maxWidth);
  const height = requestedDimension(maxHeight);
  if (width !== undefined) {
    query["maxWidth"] = width;
  }
  if (height !== undefined) {
    query["maxHeight"] = height;
  }
  return query;
};

const artworkLease = (response: JellyfinArtworkProbeResponse, configuredOrigin: string) => {
  if (response.kind === "success") {
    return {
      allowedRedirectOrigins: [configuredOrigin],
      authorizationScope: ArtworkAuthorizationScope.PUBLIC,
      headers: [],
      mimeType: response.mimeType,
      url: response.url,
    };
  }
  if (response.kind === "authentication_failed" || response.kind === "forbidden") {
    throw new ConnectError("Jellyfin artwork is not public", Code.PermissionDenied);
  }
  if (response.kind === "not_found") {
    throw new ConnectError("Jellyfin artwork was not found", Code.NotFound);
  }
  if (response.kind === "unreachable") {
    throw new ConnectError("Jellyfin server is unavailable", Code.Unavailable);
  }
  throw new ConnectError("Jellyfin artwork is not safely public", Code.FailedPrecondition);
};

const resolveJellyfinArtwork = async (
  launch: ProviderLaunchDocument,
  resolution: ArtworkResolutionRequest,
) => {
  const request = jellyfinRequestForLaunch(launch);
  const response = await request.probePublicArtwork(
    [
      "Items",
      resolution.itemId,
      "Images",
      resolution.reference.imageType,
      String(resolution.reference.imageIndex),
    ],
    {
      query: artworkQuery(resolution.reference, resolution.maxWidth, resolution.maxHeight),
      signal: resolution.signal,
    },
  );
  return artworkLease(response, request.origin);
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
  router.rpc(LibraryService.method.resolveArtwork, async (request, context) => {
    requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
    if (launch.kind !== "instance") {
      throw new ConnectError("library unavailable", Code.Unimplemented);
    }
    const { itemId, reference } = decodedArtworkRequest(request.artworkReference);
    return {
      lease: await resolveJellyfinArtwork(launch, {
        itemId,
        maxHeight: request.maxHeight,
        maxWidth: request.maxWidth,
        reference,
        signal: context.signal,
      }),
    };
  });
};

export { registerJellyfinLibraryService };
