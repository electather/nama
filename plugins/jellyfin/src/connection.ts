import { createHash } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { PluginConnectionStatus, ProviderCapability } from "@nama/api/nama/plugin/v1/plugin_pb.js";

import { jellyfinStockCapabilities } from "./info.ts";
import { createJellyfinRequest } from "./request.ts";
import type { JellyfinRequest } from "./request.ts";
import { isUnknownRecord } from "./value.ts";

const EMPTY_LENGTH = 0;
const MAXIMUM_CONNECTION_RESPONSE_BYTES = 65_536;
const MAXIMUM_REMOTE_TEXT_BYTES = 256;
const EXTENSION_PROTOCOL = "nama.jellyfin.extension";
const EXTENSION_HANDSHAKE_TIMEOUT_MILLISECONDS = 1000;
const EXTENSION_PROTOCOL_VERSION = 2;
const DIRECT_PROGRESSIVE_CAPABILITY = "direct_progressive";
const PLAYBACK_TELEMETRY_CAPABILITY = "playback_telemetry";
const EXTENSION_PLAYBACK_CAPABILITIES = [
  ProviderCapability.PLAYBACK_PLAN,
  ProviderCapability.PLAYBACK_OPEN,
  ProviderCapability.PLAYBACK_REPORT,
  ProviderCapability.PLAYBACK_REPORTS_USER_STATE,
] as const;

interface JellyfinConnectionContext {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly userId: string;
}

interface JellyfinExtensionContext {
  readonly apiKey: string;
  readonly baseUrl: string;
}

const boundedRemoteText = (value: unknown): string | undefined => {
  if (
    typeof value === "string" &&
    value.length > EMPTY_LENGTH &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_REMOTE_TEXT_BYTES
  ) {
    return value;
  }
  return undefined;
};

const principalReference = (serverId: string, userId: string): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([serverId.toLowerCase(), userId.toLowerCase()]), "utf8")
    .digest("base64url");
  return `jellyfin/v1:${digest}`;
};
const compatibleExtensionCapabilities = (value: Readonly<Record<string, unknown>>) => {
  const { capabilities } = value;
  if (
    value["protocol"] !== EXTENSION_PROTOCOL ||
    value["protocol_version"] !== EXTENSION_PROTOCOL_VERSION ||
    typeof value["extension_version"] !== "string" ||
    value["extension_version"].length === EMPTY_LENGTH ||
    !Array.isArray(capabilities) ||
    !capabilities.includes(DIRECT_PROGRESSIVE_CAPABILITY) ||
    !capabilities.includes(PLAYBACK_TELEMETRY_CAPABILITY) ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    return [];
  }
  return EXTENSION_PLAYBACK_CAPABILITIES;
};

const extensionPlaybackCapabilities = async (request: JellyfinRequest, signal: AbortSignal) => {
  const response = await request.requestJson(["Nama", "v1", "handshake"], {
    authentication: "api_key",
    cancellationSignal: signal,
    maximumResponseBytes: MAXIMUM_CONNECTION_RESPONSE_BYTES,
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(EXTENSION_HANDSHAKE_TIMEOUT_MILLISECONDS),
    ]),
  });
  if (response.kind !== "success") {
    return [];
  }
  return compatibleExtensionCapabilities(response.body);
};

const requireJellyfinExtensionPlayback = async (
  context: JellyfinExtensionContext,
  signal: AbortSignal,
) => {
  const request = createJellyfinRequest(context);
  if (request === undefined) {
    throw new ConnectError("Jellyfin extension playback is unavailable", Code.Unimplemented);
  }
  const capabilities = await extensionPlaybackCapabilities(request, signal);
  if (capabilities.length === EMPTY_LENGTH) {
    throw new ConnectError("Jellyfin extension playback is unavailable", Code.Unimplemented);
  }
};

const nonConnected = (status: PluginConnectionStatus, summary: string) => ({
  capabilities: [],
  status,
  summary,
});

const failedConnection = (
  kind: "authentication_failed" | "forbidden" | "incompatible" | "not_found" | "unreachable",
  requestUsedApiKey: boolean,
) => {
  if (
    requestUsedApiKey &&
    (kind === "authentication_failed" || kind === "forbidden" || kind === "not_found")
  ) {
    return nonConnected(
      PluginConnectionStatus.AUTHENTICATION_FAILED,
      "Jellyfin authentication failed",
    );
  }
  if (kind === "unreachable") {
    return nonConnected(PluginConnectionStatus.UNREACHABLE, "Jellyfin server is unavailable");
  }
  return nonConnected(PluginConnectionStatus.INCOMPATIBLE, "Jellyfin server is incompatible");
};

const remoteDetails = (system: Readonly<Record<string, unknown>>) => {
  const details: { remoteName?: string; remoteVersion?: string } = {};
  const remoteName = boundedRemoteText(system["ServerName"]);
  const remoteVersion = boundedRemoteText(system["Version"]);
  if (remoteName !== undefined) {
    details.remoteName = remoteName;
  }
  if (remoteVersion !== undefined) {
    details.remoteVersion = remoteVersion;
  }
  return details;
};

// oxlint-disable-next-line eslint/max-params -- Identity verification requires the configured context plus both provider response identities.
const verifyConnectionIdentity = (
  context: JellyfinConnectionContext,
  serverId: string,
  system: Readonly<Record<string, unknown>>,
  user: Readonly<Record<string, unknown>>,
) => {
  const returnedUserId = boundedRemoteText(user["Id"]);
  const returnedServerId = boundedRemoteText(user["ServerId"]);
  const policy = user["Policy"];
  if (
    returnedUserId?.toLowerCase() !== context.userId.toLowerCase() ||
    returnedServerId?.toLowerCase() !== serverId.toLowerCase() ||
    !isUnknownRecord(policy) ||
    policy["IsDisabled"] !== false
  ) {
    return nonConnected(
      PluginConnectionStatus.INCOMPATIBLE,
      "Jellyfin user identity is incompatible",
    );
  }
  return {
    capabilities: jellyfinStockCapabilities,
    ...remoteDetails(system),
    providerUserReference: principalReference(serverId, context.userId),
    status: PluginConnectionStatus.CONNECTED,
    summary: "Connected",
  };
};

// oxlint-disable-next-line eslint/max-statements -- Connection verification must sequence public server identity before authenticated user lookup.
const getJellyfinConnection = async (context: JellyfinConnectionContext, signal: AbortSignal) => {
  const request = createJellyfinRequest({
    apiKey: context.apiKey,
    baseUrl: context.baseUrl,
  });
  if (request === undefined) {
    return nonConnected(PluginConnectionStatus.INCOMPATIBLE, "Jellyfin base URL is not supported");
  }
  const system = await request.requestJson(["System", "Info", "Public"], {
    authentication: "none",
    maximumResponseBytes: MAXIMUM_CONNECTION_RESPONSE_BYTES,
    signal,
  });
  if (system.kind !== "success") {
    return failedConnection(system.kind, false);
  }
  const serverId = boundedRemoteText(system.body["Id"]);
  if (serverId === undefined) {
    return nonConnected(PluginConnectionStatus.INCOMPATIBLE, "Jellyfin server identity is invalid");
  }
  const user = await request.requestJson(["Users", context.userId], {
    authentication: "api_key",
    maximumResponseBytes: MAXIMUM_CONNECTION_RESPONSE_BYTES,
    signal,
  });
  if (user.kind !== "success") {
    return failedConnection(user.kind, true);
  }
  const connection = verifyConnectionIdentity(context, serverId, system.body, user.body);
  if (connection.status !== PluginConnectionStatus.CONNECTED) {
    return connection;
  }
  return {
    ...connection,
    capabilities: [
      ...connection.capabilities,
      ...(await extensionPlaybackCapabilities(request, signal)),
    ],
  };
};

export { getJellyfinConnection, requireJellyfinExtensionPlayback };
export type { JellyfinConnectionContext };
