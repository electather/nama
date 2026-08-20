// oxlint-disable eslint/max-statements, eslint/no-magic-numbers, eslint/no-ternary -- Private-network and HTTP-status policy stays literal and sequential so the request trust boundary is auditable.
import { isIP } from "node:net";

import { Code, ConnectError } from "@connectrpc/connect";

import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const BITS_PER_IPV4_OCTET = 8;
const IPV4_OCTET_MASK = 255;
const BACKSLASH = "\\";
const ESCAPED_BACKSLASH = BACKSLASH.repeat(2);
const AUTHENTICATION_FAILURE_STATUSES = new Set([401, 403, 404]);
const FAILURE_SENTINEL = Symbol("failure");

type JellyfinRequestContext = Readonly<{ apiKey: string; baseUrl: string }>;

interface JellyfinRequestOptions {
  readonly authentication: "api_key" | "none";
  readonly maximumResponseBytes: number;
  readonly signal: AbortSignal;
}

type JellyfinRequestTarget = Readonly<{ authorization: string; baseUrl: URL }>;

type JellyfinJsonResponse =
  | {
      readonly body: Readonly<Record<string, unknown>>;
      readonly kind: "success";
    }
  | {
      readonly kind: "authentication_failed" | "incompatible" | "unreachable";
    };

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

const mappedIpv4Address = (hostname: string): string | undefined => {
  const prefix = "::ffff:";
  if (!hostname.startsWith(prefix)) {
    return undefined;
  }
  const suffix = hostname.slice(prefix.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const [highText, lowText, ...extra] = suffix.split(":");
  if (
    highText === undefined ||
    lowText === undefined ||
    extra.length > EMPTY_LENGTH ||
    !/^[\da-f]{1,4}$/u.test(highText) ||
    !/^[\da-f]{1,4}$/u.test(lowText)
  ) {
    return undefined;
  }
  const high = Number.parseInt(highText, 16);
  const low = Number.parseInt(lowText, 16);
  return `${high >>> BITS_PER_IPV4_OCTET}.${high & IPV4_OCTET_MASK}.${low >>> BITS_PER_IPV4_OCTET}.${low & IPV4_OCTET_MASK}`;
};

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4 !== undefined) {
    return isPrivateIpv4(mappedIpv4);
  }
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

const isPrivateHostname = (hostname: string): boolean => {
  const normalized = hostname.replaceAll(/^\[|\]$/gu, "").toLowerCase();
  const addressFamily = isIP(normalized);
  if (addressFamily === 4) {
    return isPrivateIpv4(normalized);
  }
  if (addressFamily === 6) {
    return isPrivateIpv6(normalized);
  }
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    !normalized.includes(".")
  );
};

const normalizedBaseUrl = (value: string): URL | undefined => {
  const parsed = (() => {
    try {
      return new URL(value);
    } catch {
      return FAILURE_SENTINEL;
    }
  })();
  if (parsed === FAILURE_SENTINEL) {
    return undefined;
  }
  const pathSegments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > EMPTY_LENGTH);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > EMPTY_LENGTH ||
    parsed.password.length > EMPTY_LENGTH ||
    parsed.search.length > EMPTY_LENGTH ||
    parsed.hash.length > EMPTY_LENGTH ||
    pathSegments.length > 1 ||
    !isPrivateHostname(parsed.hostname)
  ) {
    return undefined;
  }
  parsed.pathname = pathSegments.length === EMPTY_LENGTH ? "/" : `/${pathSegments[0]}/`;
  return parsed;
};

const confinedEndpoint = (baseUrl: URL, pathSegments: readonly string[]): URL | undefined => {
  if (
    pathSegments.length === EMPTY_LENGTH ||
    pathSegments.some((segment) => segment.length === EMPTY_LENGTH)
  ) {
    return undefined;
  }
  const endpoint = new URL(
    pathSegments.map((segment) => encodeURIComponent(segment)).join("/"),
    baseUrl,
  );
  if (endpoint.origin !== baseUrl.origin || !endpoint.pathname.startsWith(baseUrl.pathname)) {
    return undefined;
  }
  return endpoint;
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
  const endpoint = confinedEndpoint(target.baseUrl, pathSegments);
  if (endpoint === undefined) {
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
  if (AUTHENTICATION_FAILURE_STATUSES.has(response.status)) {
    if (options.authentication === "api_key") {
      return { kind: "authentication_failed" };
    }
    return { kind: "incompatible" };
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
  if (baseUrl === undefined) {
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
