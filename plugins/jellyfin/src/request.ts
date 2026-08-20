// oxlint-disable eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Private-network and HTTP-status policy stays literal and sequential so the request trust boundary is auditable.

import { Code, ConnectError } from "@connectrpc/connect";

import { readJellyfinFailureResponse } from "./request-failure.ts";
import type { JellyfinFailureResponse, JellyfinRequestAuthentication } from "./request-failure.ts";
import { confinedEndpoint, INVALID_REQUEST_TARGET, normalizedBaseUrl } from "./request-target.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = BACKSLASH.repeat(2);
const FAILURE_SENTINEL = Symbol("failure");

type JellyfinRequestContext = Readonly<{ apiKey: string; baseUrl: string }>;

interface JellyfinRequestOptions {
  readonly authentication: JellyfinRequestAuthentication;
  readonly cancellationSignal?: AbortSignal;
  readonly maximumResponseBytes: number;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
interface JellyfinMutationRequestOptions extends JellyfinRequestOptions {
  readonly cancellationSignal: AbortSignal;
  readonly method: "DELETE" | "POST";
}

type JellyfinRequestTarget = Readonly<{ authorization: string; baseUrl: URL }>;

type JellyfinJsonResponse =
  | {
      readonly body: Readonly<Record<string, unknown>>;
      readonly kind: "success";
    }
  | JellyfinFailureResponse;
type JellyfinMutationResponse = JellyfinJsonResponse | Readonly<{ kind: "ambiguous" }>;
interface PreparedJellyfinRequest {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
}
interface JellyfinFetchRequest {
  readonly endpoint: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: "DELETE" | "GET" | "POST";
  readonly signal: AbortSignal;
}
interface JellyfinRequest {
  readonly requestJson: (
    pathSegments: readonly string[],
    options: JellyfinRequestOptions,
  ) => Promise<JellyfinJsonResponse>;
  readonly requestMutationJson: (
    pathSegments: readonly string[],
    options: JellyfinMutationRequestOptions,
  ) => Promise<JellyfinMutationResponse>;
}

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
    requestJson: (pathSegments: readonly string[], options: JellyfinRequestOptions) =>
      sendJsonRequest(target, pathSegments, options),
    requestMutationJson: (
      pathSegments: readonly string[],
      options: JellyfinMutationRequestOptions,
    ) => sendMutationRequest(target, pathSegments, options),
  };
};

export { createJellyfinRequest };
export type { JellyfinJsonResponse, JellyfinMutationResponse, JellyfinRequest };
