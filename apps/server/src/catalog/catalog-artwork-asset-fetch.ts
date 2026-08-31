import { Effect } from "effect";

import type { CatalogArtworkAsset } from "../database/catalog-persistence-model-private.ts";
import type { ProviderActivityAdmission } from "../provider/provider-activity.ts";
import { validatedArtworkLease } from "./catalog-artwork-lease.ts";
import type { ValidatedArtworkLease } from "./catalog-artwork-lease.ts";
import { normalizedLocatorOrigin } from "./catalog-artwork-origin.ts";
import type {
  CatalogArtworkLeaseRequest,
  CatalogArtworkLeaseResolver,
} from "./catalog-artwork-provider-model.ts";

const MAXIMUM_ARTWORK_ASSET_BYTES = 20_971_520;
const MAXIMUM_REDIRECTS = 5;
const ZERO = 0;
const ONE = 1;
const NO_ARTWORK_ASSET = undefined;
const REDIRECT_STATUS: Readonly<Record<number, true>> = {
  301: true,
  302: true,
  303: true,
  307: true,
  308: true,
};

interface ArtworkAssetLoadInput extends CatalogArtworkLeaseRequest {
  readonly now: number;
}

type LoadArtworkAsset = (
  input: ArtworkAssetLoadInput,
) => Effect.Effect<CatalogArtworkAsset | undefined>;

const responseMimeType = (response: Response): string | undefined => {
  const contentType = response.headers.get("content-type");
  if (contentType === null) {
    return undefined;
  }
  return contentType.split(";").at(ZERO)?.trim().toLowerCase();
};

const validateDeclaredLength = (response: Response): void => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength === null) {
    return;
  }
  const length = Number(declaredLength);
  if (!Number.isSafeInteger(length) || length <= ZERO || length > MAXIMUM_ARTWORK_ASSET_BYTES) {
    throw new Error("artwork asset length is invalid");
  }
};

interface ArtworkByteState {
  readonly chunks: Buffer[];
  readonly total: number;
}

const completedArtworkBytes = (state: ArtworkByteState): Buffer => {
  if (state.total === ZERO) {
    throw new Error("artwork asset is empty");
  }
  return Buffer.concat(state.chunks, state.total);
};

const readNextArtworkChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ArtworkByteState,
): Promise<Buffer> => {
  const result = await reader.read();
  if (result.done) {
    return completedArtworkBytes(state);
  }
  const total = state.total + result.value.byteLength;
  if (total > MAXIMUM_ARTWORK_ASSET_BYTES) {
    await reader.cancel();
    throw new Error("artwork asset is too large");
  }
  state.chunks.push(Buffer.from(result.value));
  return readNextArtworkChunk(reader, { chunks: state.chunks, total });
};

const readBoundedBytes = (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Buffer> =>
  readNextArtworkChunk(reader, { chunks: [], total: ZERO });

const boundedResponseBytes = async (response: Response): Promise<Buffer> => {
  const { body } = response;
  if (body === null) {
    throw new Error("artwork asset body is missing");
  }
  try {
    validateDeclaredLength(response);
  } catch (error) {
    await body.cancel();
    throw error;
  }
  return readBoundedBytes(body.getReader());
};

interface ArtworkRedirect {
  readonly headers: Readonly<Record<string, string>>;
  readonly url: URL;
}

interface ArtworkRedirectInput {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly headers: Readonly<Record<string, string>>;
  readonly redirectCount: number;
  readonly response: Response;
  readonly url: URL;
}

const requiredRedirectLocation = (response: Response, redirectCount: number): string => {
  const location = response.headers.get("location");
  if (location === null || redirectCount === MAXIMUM_REDIRECTS) {
    throw new Error("artwork asset redirect is invalid");
  }
  return location;
};

const allowedRedirect = (
  location: string,
  url: URL,
  allowedOrigins: ReadonlySet<string>,
): { readonly origin: string; readonly url: URL } => {
  const redirected = new URL(location, url);
  const origin = normalizedLocatorOrigin(redirected.toString());
  if (origin === undefined || !allowedOrigins.has(origin)) {
    throw new Error("artwork asset redirect origin is forbidden");
  }
  return { origin, url: redirected };
};

const redirectedHeaders = (
  headers: Readonly<Record<string, string>>,
  currentOrigin: string,
  redirectedOrigin: string,
): Readonly<Record<string, string>> => {
  if (redirectedOrigin === currentOrigin) {
    return headers;
  }
  return {};
};

const artworkRedirect = ({
  allowedOrigins,
  headers,
  redirectCount,
  response,
  url,
}: ArtworkRedirectInput): ArtworkRedirect | undefined => {
  if (!Object.hasOwn(REDIRECT_STATUS, response.status)) {
    return undefined;
  }
  const location = requiredRedirectLocation(response, redirectCount);
  const redirected = allowedRedirect(location, url, allowedOrigins);
  return {
    headers: redirectedHeaders(headers, url.origin, redirected.origin),
    url: redirected.url,
  };
};

interface ArtworkFetchContext {
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly validated: ValidatedArtworkLease;
}

interface ArtworkRequestState {
  readonly headers: Readonly<Record<string, string>>;
  readonly redirectCount: number;
  readonly url: URL;
}

const requireUnexpiredAccess = (validated: ValidatedArtworkLease, now: () => number): void => {
  if (validated.accessExpiresAt !== undefined && validated.accessExpiresAt <= now()) {
    throw new Error("artwork asset access expired");
  }
};

const requireValidArtworkResponse = async (
  response: Response,
  validated: ValidatedArtworkLease,
): Promise<void> => {
  if (response.ok && responseMimeType(response) === validated.mimeType) {
    return;
  }
  await response.body?.cancel();
  throw new Error("artwork asset response is invalid");
};

interface FollowArtworkRedirectInput {
  readonly next: (state: ArtworkRequestState) => Promise<CatalogArtworkAsset>;
  readonly redirect: ArtworkRedirect;
  readonly response: Response;
  readonly state: ArtworkRequestState;
}

const followArtworkRedirect = async ({
  next,
  redirect,
  response,
  state,
}: FollowArtworkRedirectInput): Promise<CatalogArtworkAsset> => {
  await response.body?.cancel();
  return next({
    ...redirect,
    redirectCount: state.redirectCount + ONE,
  });
};

const fetchArtworkResponse = async (
  context: ArtworkFetchContext,
  state: ArtworkRequestState,
): Promise<CatalogArtworkAsset> => {
  requireUnexpiredAccess(context.validated, context.now);
  // fallow-ignore-next-line security-sink -- The initial and every redirect origin must exactly match the provider-configuration allowlist; cross-origin redirects also lose authorization.
  const response = await fetch(state.url, {
    headers: state.headers,
    redirect: "manual",
    signal: context.signal,
  });
  const redirect = artworkRedirect({
    allowedOrigins: context.validated.allowedOrigins,
    headers: state.headers,
    redirectCount: state.redirectCount,
    response,
    url: state.url,
  });
  if (redirect !== undefined) {
    return followArtworkRedirect({
      next: (nextState) => fetchArtworkResponse(context, nextState),
      redirect,
      response,
      state,
    });
  }
  await requireValidArtworkResponse(response, context.validated);
  const bytes = await boundedResponseBytes(response);
  return { bytes, mimeType: context.validated.mimeType };
};

const fetchArtworkAsset = (
  validated: ValidatedArtworkLease,
  now: () => number,
  signal: AbortSignal,
): Promise<CatalogArtworkAsset> =>
  fetchArtworkResponse(
    { now, signal, validated },
    { headers: validated.headers, redirectCount: ZERO, url: validated.url },
  );

const unguardedProviderActivity: ProviderActivityAdmission["run"] = (
  _providerInstanceId,
  activity,
) => activity;

const makeArtworkAssetLoader =
  (
    resolveArtworkLease: CatalogArtworkLeaseResolver,
    runProviderActivity: ProviderActivityAdmission["run"] = unguardedProviderActivity,
    now: () => number = Date.now,
  ): LoadArtworkAsset =>
  (input) =>
    runProviderActivity(
      input.providerInstanceId,
      resolveArtworkLease(input).pipe(
        Effect.flatMap(({ approvedOrigins, lease }) => {
          const validated = validatedArtworkLease(lease, approvedOrigins, input.now);
          if (validated === undefined) {
            return Effect.succeed(NO_ARTWORK_ASSET);
          }
          return Effect.tryPromise({
            catch: () => {},
            try: (signal) => fetchArtworkAsset(validated, now, signal),
          }).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.succeed(NO_ARTWORK_ASSET),
              onSuccess: Effect.succeed,
            }),
          );
        }),
        Effect.matchEffect({
          onFailure: () => Effect.succeed(NO_ARTWORK_ASSET),
          onSuccess: Effect.succeed,
        }),
      ),
    ).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.succeed(NO_ARTWORK_ASSET),
        onSuccess: Effect.succeed,
      }),
    );

export { makeArtworkAssetLoader };
export type { ArtworkAssetLoadInput, LoadArtworkAsset };
