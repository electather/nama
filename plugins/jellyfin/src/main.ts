// oxlint-disable eslint/max-statements, eslint/no-magic-numbers -- The stdin boundary keeps byte accounting, schema byte limits, and exact launch-document rejection explicit.
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";

import { getJellyfinConnection } from "./connection.ts";
import { jellyfinPluginInfo } from "./info.ts";

const MAXIMUM_LAUNCH_DOCUMENT_BYTES = 65_536;
const LAUNCH_DOCUMENT_VERSION = 2;
const EXIT_CONFIGURATION_ERROR = 64;
const EMPTY_LENGTH = 0;
const PRIVATE_PROCESS_UMASK = 0o177;
const PRIVATE_SOCKET_MODE = 0o600;
const SUCCESS_EXIT_CODE = 0;

interface DiscoveryLaunchDocument {
  readonly bearer: string;
  readonly kind: "discovery";
  readonly socket_path: string;
  readonly version: typeof LAUNCH_DOCUMENT_VERSION;
}

interface ProviderLaunchDocument {
  readonly bearer: string;
  readonly configuration: Readonly<{
    readonly base_url: string;
    readonly user_id: string;
  }>;
  readonly credentials: Readonly<{ readonly api_key: string }>;
  readonly kind: "candidate" | "instance";
  readonly provider_instance_id?: string;
  readonly provider_type: "jellyfin";
  readonly revision?: string;
  readonly socket_path: string;
  readonly version: typeof LAUNCH_DOCUMENT_VERSION;
}

type LaunchDocument = DiscoveryLaunchDocument | ProviderLaunchDocument;

const dataProperties = (value: object): Readonly<Record<string, unknown>> | undefined => {
  const properties: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
      return undefined;
    }
    properties[key] = descriptor.value;
  }
  return properties;
};

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): boolean => {
  const actualKeys = Object.keys(value).toSorted();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
};

const isCommonLaunchDocument = (document: Readonly<Record<string, unknown>>): boolean =>
  document["version"] === LAUNCH_DOCUMENT_VERSION &&
  typeof document["bearer"] === "string" &&
  document["bearer"].length > EMPTY_LENGTH &&
  typeof document["socket_path"] === "string" &&
  document["socket_path"].length > EMPTY_LENGTH &&
  !document["socket_path"].includes("\0");

const providerContext = (
  document: Readonly<Record<string, unknown>>,
):
  | Readonly<{
      readonly configuration: Readonly<Record<string, unknown>>;
      readonly credentials: Readonly<Record<string, unknown>>;
    }>
  | undefined => {
  const configurationValue = document["configuration"];
  const credentialsValue = document["credentials"];
  if (
    typeof configurationValue !== "object" ||
    configurationValue === null ||
    Array.isArray(configurationValue) ||
    typeof credentialsValue !== "object" ||
    credentialsValue === null ||
    Array.isArray(credentialsValue)
  ) {
    return undefined;
  }
  const configuration = dataProperties(configurationValue);
  const credentials = dataProperties(credentialsValue);
  if (
    configuration === undefined ||
    credentials === undefined ||
    !hasExactKeys(configuration, ["base_url", "user_id"]) ||
    !hasExactKeys(credentials, ["api_key"]) ||
    typeof configuration["base_url"] !== "string" ||
    Buffer.byteLength(configuration["base_url"], "utf8") === EMPTY_LENGTH ||
    Buffer.byteLength(configuration["base_url"], "utf8") > 2048 ||
    typeof configuration["user_id"] !== "string" ||
    Buffer.byteLength(configuration["user_id"], "utf8") === EMPTY_LENGTH ||
    Buffer.byteLength(configuration["user_id"], "utf8") > 128 ||
    typeof credentials["api_key"] !== "string" ||
    Buffer.byteLength(credentials["api_key"], "utf8") === EMPTY_LENGTH ||
    Buffer.byteLength(credentials["api_key"], "utf8") > 4096
  ) {
    return undefined;
  }
  return { configuration, credentials };
};

const isLaunchDocument = (value: unknown): value is LaunchDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const document = dataProperties(value);
  if (document === undefined || !isCommonLaunchDocument(document)) {
    return false;
  }
  if (document["kind"] === "discovery") {
    return hasExactKeys(document, ["bearer", "kind", "socket_path", "version"]);
  }
  const context = providerContext(document);
  if (context === undefined || document["provider_type"] !== "jellyfin") {
    return false;
  }
  if (document["kind"] === "candidate") {
    return hasExactKeys(document, [
      "bearer",
      "configuration",
      "credentials",
      "kind",
      "provider_type",
      "socket_path",
      "version",
    ]);
  }
  return (
    document["kind"] === "instance" &&
    hasExactKeys(document, [
      "bearer",
      "configuration",
      "credentials",
      "kind",
      "provider_instance_id",
      "provider_type",
      "revision",
      "socket_path",
      "version",
    ]) &&
    typeof document["provider_instance_id"] === "string" &&
    document["provider_instance_id"].length > EMPTY_LENGTH &&
    typeof document["revision"] === "string" &&
    document["revision"].length > EMPTY_LENGTH
  );
};

const readStdin = async (): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let bytes = EMPTY_LENGTH;
  for await (const chunk of process.stdin) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("launch document contains an invalid chunk");
    }
    bytes += chunk.byteLength;
    if (bytes > MAXIMUM_LAUNCH_DOCUMENT_BYTES) {
      throw new Error("launch document exceeds limit");
    }
    chunks.push(chunk);
  }
  if (bytes === EMPTY_LENGTH) {
    throw new Error("launch document is empty");
  }
  return Buffer.concat(chunks);
};

const readLaunchDocument = async (): Promise<LaunchDocument> => {
  const value: unknown = JSON.parse(Buffer.from(await readStdin()).toString("utf8"));
  if (!isLaunchDocument(value)) {
    throw new Error("launch document is invalid");
  }
  return value;
};

const bearerMatches = (authorization: string | null, bearer: string): boolean => {
  if (authorization === null) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${bearer}`, "utf8");
  const actual = Buffer.from(authorization, "utf8");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
};

const requireAuthorization = (authorization: string | null, bearer: string): void => {
  if (!bearerMatches(authorization, bearer)) {
    throw new ConnectError("authentication failed", Code.Unauthenticated);
  }
};

const makeHandler = (launch: LaunchDocument) =>
  connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: false,
    routes: (router) => {
      router.service(HealthService, {
        check: (_request, context) => {
          requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
          return { status: ServingStatus.SERVING };
        },
      });
      router.service(PluginService, {
        getConnection: async (_request, context) => {
          requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
          if (launch.kind === "discovery") {
            throw new ConnectError("connection unavailable", Code.Unimplemented);
          }
          return {
            connection: await getJellyfinConnection(
              {
                apiKey: launch.credentials.api_key,
                baseUrl: launch.configuration.base_url,
                userId: launch.configuration.user_id,
              },
              context.signal,
            ),
          };
        },
        getInfo: (_request, context) => {
          requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
          return { pluginInfo: jellyfinPluginInfo };
        },
      });
    },
  });

const startServer = async (launch: LaunchDocument): Promise<Server> => {
  const server = createServer(makeHandler(launch));
  const listening = once(server, "listening");
  server.listen(launch.socket_path);
  await listening;
  await chmod(launch.socket_path, PRIVATE_SOCKET_MODE);
  return server;
};

const installShutdown = (server: Server): void => {
  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    server.close(() => {
      process.exitCode = SUCCESS_EXIT_CODE;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
};

const run = async (): Promise<void> => {
  process.umask(PRIVATE_PROCESS_UMASK);
  const launch = await readLaunchDocument();
  installShutdown(await startServer(launch));
};

try {
  await run();
} catch {
  process.exitCode = EXIT_CONFIGURATION_ERROR;
}
