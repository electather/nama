// oxlint-disable eslint/init-declarations, eslint/max-lines-per-function, eslint/max-statements, eslint/no-await-in-loop, eslint/no-magic-numbers, eslint/no-ternary, unicorn/prefer-string-raw -- The native fetch adapter keeps private-address, redirect, bounded-body, cancellation, identity, and safe-status policy explicit.
import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { Code, ConnectError } from "@connectrpc/connect";
import { PluginConnectionStatus } from "@nama/api/nama/plugin/v1/plugin_pb.js";

const EMPTY_LENGTH = 0;
const MAXIMUM_RESPONSE_BYTES = 65_536;
const MAXIMUM_REMOTE_TEXT_BYTES = 256;
const SINGLE_PATH_PREFIX = 1;

interface JellyfinConnectionContext {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userId: string;
}

interface JsonResponse {
  readonly body?: Readonly<Record<string, unknown>>;
  readonly kind: "authentication_failed" | "incompatible" | "success" | "unreachable";
}
const isJsonRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
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
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
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
    pathSegments.length > SINGLE_PATH_PREFIX ||
    !isPrivateHostname(parsed.hostname)
  ) {
    return undefined;
  }
  parsed.pathname = pathSegments.length === EMPTY_LENGTH ? "/" : `/${pathSegments[0]}/`;
  return parsed;
};

const endpoint = (baseUrl: URL, path: string): URL => new URL(path, baseUrl);

const readBoundedJson = async (
  response: Response,
): Promise<Readonly<Record<string, unknown>> | undefined> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let bytes = EMPTY_LENGTH;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }
    bytes += chunk.value.byteLength;
    if (bytes > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(chunk.value);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
    if (!isJsonRecord(value)) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
};

const requestJson = async (
  url: URL,
  signal: AbortSignal,
  authorization?: string,
): Promise<JsonResponse> => {
  let response: Response;
  try {
    response = await fetch(url, {
      headers:
        authorization === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", authorization },
      redirect: "manual",
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new ConnectError("request cancelled", Code.Canceled);
    }
    return { kind: "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) {
    return { kind: "incompatible" };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { kind: authorization === undefined ? "incompatible" : "authentication_failed" };
  }
  if (!response.ok) {
    return { kind: response.status >= 500 ? "unreachable" : "incompatible" };
  }
  const body = await readBoundedJson(response);
  return body === undefined ? { kind: "incompatible" } : { body, kind: "success" };
};

const boundedRemoteText = (value: unknown): string | undefined =>
  typeof value === "string" &&
  value.length > EMPTY_LENGTH &&
  Buffer.byteLength(value, "utf8") <= MAXIMUM_REMOTE_TEXT_BYTES
    ? value
    : undefined;

const principalReference = (serverId: string, userId: string): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([serverId.toLowerCase(), userId.toLowerCase()]), "utf8")
    .digest("base64url");
  return `jellyfin/v1:${digest}`;
};

const nonConnected = (status: PluginConnectionStatus, summary: string) => ({
  capabilities: [],
  status,
  summary,
});

const getJellyfinConnection = async (context: JellyfinConnectionContext, signal: AbortSignal) => {
  const baseUrl = normalizedBaseUrl(context.baseUrl);
  if (baseUrl === undefined) {
    return nonConnected(PluginConnectionStatus.INCOMPATIBLE, "Jellyfin base URL is not supported");
  }
  const system = await requestJson(endpoint(baseUrl, "System/Info/Public"), signal);
  if (system.kind !== "success" || system.body === undefined) {
    return nonConnected(
      system.kind === "unreachable"
        ? PluginConnectionStatus.UNREACHABLE
        : PluginConnectionStatus.INCOMPATIBLE,
      system.kind === "unreachable"
        ? "Jellyfin server is unavailable"
        : "Jellyfin server is incompatible",
    );
  }
  const serverId = boundedRemoteText(system.body["Id"]);
  if (serverId === undefined) {
    return nonConnected(PluginConnectionStatus.INCOMPATIBLE, "Jellyfin server identity is invalid");
  }
  const authorization = `MediaBrowser Token="${context.apiKey.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const user = await requestJson(
    endpoint(baseUrl, `Users/${encodeURIComponent(context.userId)}`),
    signal,
    authorization,
  );
  if (user.kind !== "success" || user.body === undefined) {
    if (user.kind === "authentication_failed") {
      return nonConnected(
        PluginConnectionStatus.AUTHENTICATION_FAILED,
        "Jellyfin authentication failed",
      );
    }
    return nonConnected(
      user.kind === "unreachable"
        ? PluginConnectionStatus.UNREACHABLE
        : PluginConnectionStatus.INCOMPATIBLE,
      user.kind === "unreachable"
        ? "Jellyfin server is unavailable"
        : "Jellyfin server is incompatible",
    );
  }
  const returnedUserId = boundedRemoteText(user.body["Id"]);
  const returnedServerId = boundedRemoteText(user.body["ServerId"]);
  const policy = user.body["Policy"];
  const disabled = isJsonRecord(policy) ? policy["IsDisabled"] : undefined;
  if (
    returnedUserId?.toLowerCase() !== context.userId.toLowerCase() ||
    returnedServerId?.toLowerCase() !== serverId.toLowerCase() ||
    disabled !== false
  ) {
    return nonConnected(
      PluginConnectionStatus.INCOMPATIBLE,
      "Jellyfin user identity is incompatible",
    );
  }
  const remoteName = boundedRemoteText(system.body["ServerName"]);
  const remoteVersion = boundedRemoteText(system.body["Version"]);
  return {
    capabilities: [],
    ...(remoteName === undefined ? {} : { remoteName }),
    ...(remoteVersion === undefined ? {} : { remoteVersion }),
    providerUserReference: principalReference(serverId, context.userId),
    status: PluginConnectionStatus.CONNECTED,
    summary: "Connected",
  };
};

export { getJellyfinConnection };
export type { JellyfinConnectionContext };
