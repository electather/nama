// oxlint-disable eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Private-network and HTTP-status policy stays literal and sequential so the request trust boundary is auditable.

import { MIMEType } from "node:util";

import { Code, ConnectError } from "@connectrpc/connect";

import { readJellyfinFailureResponse } from "./request-failure.ts";
import { confinedEndpoint, INVALID_REQUEST_TARGET, normalizedBaseUrl } from "./request-target.ts";
import type {
  JellyfinArtworkProbeOptions,
  JellyfinArtworkProbeResponse,
  JellyfinFetchRequest,
  JellyfinJsonResponse,
  JellyfinMutationRequestOptions,
  JellyfinMutationResponse,
  JellyfinRequest,
  JellyfinRequestContext,
  JellyfinRequestOptions,
  JellyfinRequestTarget,
  PreparedJellyfinRequest,
} from "./request-types.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = BACKSLASH.repeat(2);
const FAILURE_SENTINEL = Symbol("failure");
const MAXIMUM_MIME_TYPE_LENGTH = 256;
const HTTP_OK = 200;

const parseJsonRecord = (bytes: Uint8Array[], length: number) => {
  try {
    const value: unknown = JSON.parse(Buffer.concat(bytes, length).toString("utf8"));
    return isUnknownRecord(value) ? value : FAILURE_SENTINEL;
  } catch {
    return FAILURE_SENTINEL;
  }
};

const readResponseChunk = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof FAILURE_SENTINEL> => {
  try {
    return await reader.read();
  } catch {
    return FAILURE_SENTINEL;
  }
};

const readBoundedJson = async (
  response: Response,
  maximumResponseBytes: number,
  cancellationSignal: AbortSignal,
): Promise<JellyfinJsonResponse> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { kind: "incompatible" };
  }
  const chunks: Uint8Array[] = [];
  let bytes = EMPTY_LENGTH;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Stream reads are sequential by contract.
    const chunk = await readResponseChunk(reader);
    if (chunk === FAILURE_SENTINEL) {
      if (cancellationSignal.aborted) {
        throw new ConnectError("request cancelled", Code.Canceled);
      }
      return { kind: "unreachable" };
    }
    if (chunk.done) {
      break;
    }
    bytes += chunk.value.byteLength;
    if (bytes > maximumResponseBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Cancellation releases this sequential stream reader.
      const cancelled = await reader.cancel().then(
        () => true,
        () => false,
      );
      if (!cancelled && cancellationSignal.aborted) {
        throw new ConnectError("request cancelled", Code.Canceled);
      }
      return { kind: cancelled ? "incompatible" : "unreachable" };
    }
    chunks.push(chunk.value);
  }
  const body = parseJsonRecord(chunks, bytes);
  return body === FAILURE_SENTINEL ? { kind: "incompatible" } : { body, kind: "success" };
};

const fetchResponse = async ({
  endpoint,
  headers,
  method,
  signal,
}: JellyfinFetchRequest): Promise<Response | typeof FAILURE_SENTINEL> => {
  try {
    return await fetch(endpoint, { headers, method, redirect: "manual", signal });
  } catch {
    return FAILURE_SENTINEL;
  }
};
const prepareRequest = (
  target: JellyfinRequestTarget,
  pathSegments: readonly string[],
  options: JellyfinRequestOptions,
): PreparedJellyfinRequest | typeof FAILURE_SENTINEL => {
  if (
    !Number.isSafeInteger(options.maximumResponseBytes) ||
    options.maximumResponseBytes <= EMPTY_LENGTH
  ) {
    return FAILURE_SENTINEL;
  }
  const endpoint = confinedEndpoint(target.baseUrl, pathSegments, options.query);
  if (endpoint === INVALID_REQUEST_TARGET) {
    return FAILURE_SENTINEL;
  }
  const headers =
    options.authentication === "api_key"
      ? { accept: "application/json", authorization: target.authorization }
      : { accept: "application/json" };
  return { endpoint, headers };
};

const sendJsonRequest = async (
  target: JellyfinRequestTarget,
  pathSegments: readonly string[],
  options: JellyfinRequestOptions,
): Promise<JellyfinJsonResponse> => {
  const prepared = prepareRequest(target, pathSegments, options);
  if (prepared === FAILURE_SENTINEL) {
    return { kind: "incompatible" };
  }
  const cancellationSignal = options.cancellationSignal ?? options.signal;
  const response = await fetchResponse({
    endpoint: prepared.endpoint,
    headers: prepared.headers,
    method: "GET",
    signal: options.signal,
  });
  if (response === FAILURE_SENTINEL) {
    if (cancellationSignal.aborted) {
      throw new ConnectError("request cancelled", Code.Canceled);
    }
    return { kind: "unreachable" };
  }
  const failureResponse = await readJellyfinFailureResponse(
    response,
    options.authentication,
    cancellationSignal,
  );
  if (failureResponse !== undefined) {
    return failureResponse;
  }
  return readBoundedJson(response, options.maximumResponseBytes, cancellationSignal);
};
const sendMutationRequest = async (
  target: JellyfinRequestTarget,
  pathSegments: readonly string[],
  options: JellyfinMutationRequestOptions,
): Promise<JellyfinMutationResponse> => {
  const prepared = prepareRequest(target, pathSegments, options);
  if (prepared === FAILURE_SENTINEL) {
    return { kind: "incompatible" };
  }
  const response = await fetchResponse({
    endpoint: prepared.endpoint,
    headers: prepared.headers,
    method: options.method,
    signal: options.signal,
  });
  if (response === FAILURE_SENTINEL) {
    if (options.cancellationSignal.aborted) {
      throw new ConnectError("request cancelled", Code.Canceled);
    }
    return { kind: "ambiguous" };
  }
  try {
    const failureResponse = await readJellyfinFailureResponse(
      response,
      options.authentication,
      options.cancellationSignal,
    );
    if (failureResponse !== undefined) {
      return failureResponse;
    }
    const body = await readBoundedJson(
      response,
      options.maximumResponseBytes,
      options.cancellationSignal,
    );
    return body.kind === "success" ? body : { kind: "ambiguous" };
  } catch (error) {
    if (
      !options.cancellationSignal.aborted &&
      options.signal.aborted &&
      error instanceof ConnectError &&
      error.code === Code.Canceled
    ) {
      return { kind: "ambiguous" };
    }
    throw error;
  }
};

const normalizedImageMimeType = (value: string | null): string | undefined => {
  if (value === null || Buffer.byteLength(value, "utf8") > MAXIMUM_MIME_TYPE_LENGTH) {
    return undefined;
  }
  try {
    const mimeType = new MIMEType(value);
    if (mimeType.type !== "image") {
      return undefined;
    }
    return mimeType.essence;
  } catch {
    return undefined;
  }
};

const sendArtworkProbe = async (
  baseUrl: URL,
  pathSegments: readonly string[],
  options: JellyfinArtworkProbeOptions,
): Promise<JellyfinArtworkProbeResponse> => {
  const endpoint = confinedEndpoint(baseUrl, pathSegments, options.query);
  if (endpoint === INVALID_REQUEST_TARGET) {
    return { kind: "incompatible" };
  }
  const response = await fetchResponse({
    endpoint,
    headers: { accept: "image/*" },
    method: "HEAD",
    signal: options.signal,
  });
  if (response === FAILURE_SENTINEL) {
    if (options.signal.aborted) {
      throw new ConnectError("request cancelled", Code.Canceled);
    }
    return { kind: "unreachable" };
  }
  const failureResponse = await readJellyfinFailureResponse(response, "none", options.signal);
  if (failureResponse !== undefined) {
    return failureResponse;
  }
  if (response.status !== HTTP_OK) {
    return { kind: "incompatible" };
  }
  const mimeType = normalizedImageMimeType(response.headers.get("content-type"));
  return mimeType === undefined
    ? { kind: "incompatible" }
    : { kind: "success", mimeType, url: endpoint.href };
};

const createJellyfinRequest = (context: JellyfinRequestContext): JellyfinRequest | undefined => {
  const baseUrl = normalizedBaseUrl(context.baseUrl);
  if (baseUrl === INVALID_REQUEST_TARGET) {
    return undefined;
  }
  const escapedApiKey = context.apiKey
    .replaceAll(BACKSLASH, ESCAPED_BACKSLASH)
    .replaceAll('"', String.raw`\"`);
  const authorization = `MediaBrowser Token="${escapedApiKey}"`;
  const target = { authorization, baseUrl };

  return {
    origin: baseUrl.origin,
    probePublicArtwork: (pathSegments: readonly string[], options: JellyfinArtworkProbeOptions) =>
      sendArtworkProbe(baseUrl, pathSegments, options),
    requestJson: (pathSegments: readonly string[], options: JellyfinRequestOptions) =>
      sendJsonRequest(target, pathSegments, options),
    requestMutationJson: (
      pathSegments: readonly string[],
      options: JellyfinMutationRequestOptions,
    ) => sendMutationRequest(target, pathSegments, options),
  };
};

export { createJellyfinRequest };
export type {
  JellyfinArtworkProbeResponse,
  JellyfinJsonResponse,
  JellyfinMutationResponse,
  JellyfinRequest,
};
