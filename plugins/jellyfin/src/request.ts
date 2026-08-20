// oxlint-disable eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Private-network and HTTP-status policy stays literal and sequential so the request trust boundary is auditable.

import { Code, ConnectError } from "@connectrpc/connect";

import { confinedEndpoint, INVALID_REQUEST_TARGET, normalizedBaseUrl } from "./request-target.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = BACKSLASH.repeat(2);
const FAILURE_SENTINEL = Symbol("failure");

type JellyfinRequestContext = Readonly<{ apiKey: string; baseUrl: string }>;

interface JellyfinRequestOptions {
  readonly authentication: "api_key" | "none";
  readonly maximumResponseBytes: number;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

type JellyfinRequestTarget = Readonly<{ authorization: string; baseUrl: URL }>;

type JellyfinJsonResponse =
  | {
      readonly body: Readonly<Record<string, unknown>>;
      readonly kind: "success";
    }
  | {
      readonly kind:
        | "authentication_failed"
        | "forbidden"
        | "incompatible"
        | "not_found"
        | "unreachable";
    };

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
  signal: AbortSignal,
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
      if (signal.aborted) {
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
      if (!cancelled && signal.aborted) {
        throw new ConnectError("request cancelled", Code.Canceled);
      }
      return { kind: cancelled ? "incompatible" : "unreachable" };
    }
    chunks.push(chunk.value);
  }
  const body = parseJsonRecord(chunks, bytes);
  return body === FAILURE_SENTINEL ? { kind: "incompatible" } : { body, kind: "success" };
};

const requestHeaders = (
  authentication: JellyfinRequestOptions["authentication"],
  authorization: string,
): Readonly<Record<string, string>> => {
  if (authentication === "api_key") {
    return { accept: "application/json", authorization };
  }
  return { accept: "application/json" };
};

const fetchResponse = async (
  endpoint: URL,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Response | typeof FAILURE_SENTINEL> => {
  try {
    return await fetch(endpoint, { headers, redirect: "manual", signal });
  } catch {
    return FAILURE_SENTINEL;
  }
};

const sendJsonRequest = async (
  target: JellyfinRequestTarget,
  pathSegments: readonly string[],
  options: JellyfinRequestOptions,
): Promise<JellyfinJsonResponse> => {
  if (
    !Number.isSafeInteger(options.maximumResponseBytes) ||
    options.maximumResponseBytes <= EMPTY_LENGTH
  ) {
    return { kind: "incompatible" };
  }
  const endpoint = confinedEndpoint(target.baseUrl, pathSegments, options.query);
  if (endpoint === INVALID_REQUEST_TARGET) {
    return { kind: "incompatible" };
  }
  const response = await fetchResponse(
    endpoint,
    requestHeaders(options.authentication, target.authorization),
    options.signal,
  );
  if (response === FAILURE_SENTINEL) {
    if (options.signal.aborted) {
      throw new ConnectError("request cancelled", Code.Canceled);
    }
    return { kind: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "incompatible" };
  }
  if (response.status === 401) {
    return {
      kind: options.authentication === "api_key" ? "authentication_failed" : "incompatible",
    };
  }
  if (response.status === 403) {
    return { kind: options.authentication === "api_key" ? "forbidden" : "incompatible" };
  }
  if (response.status === 404) {
    return { kind: options.authentication === "api_key" ? "not_found" : "incompatible" };
  }
  if (!response.ok) {
    if (response.status >= 500) {
      return { kind: "unreachable" };
    }
    return { kind: "incompatible" };
  }
  return readBoundedJson(response, options.maximumResponseBytes, options.signal);
};

const createJellyfinRequest = (context: JellyfinRequestContext) => {
  const baseUrl = normalizedBaseUrl(context.baseUrl);
  if (baseUrl === INVALID_REQUEST_TARGET) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Invalid base URLs make this optional factory unavailable.
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
  };
};

export { createJellyfinRequest };
export type { JellyfinJsonResponse };
