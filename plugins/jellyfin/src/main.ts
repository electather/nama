// oxlint-disable eslint/max-statements -- The stdin boundary keeps byte accounting and exact launch-document rejection explicit.
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";

import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";

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

const isDiscoveryLaunchDocument = (value: unknown): value is DiscoveryLaunchDocument => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const document = dataProperties(value);
  if (document === undefined) {
    return false;
  }
  const actualKeys = Object.keys(document).toSorted();
  const expectedKeys = ["bearer", "kind", "socket_path", "version"];
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    document["version"] === LAUNCH_DOCUMENT_VERSION &&
    document["kind"] === "discovery" &&
    typeof document["bearer"] === "string" &&
    document["bearer"].length > EMPTY_LENGTH &&
    typeof document["socket_path"] === "string" &&
    document["socket_path"].length > EMPTY_LENGTH &&
    !document["socket_path"].includes("\0")
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

const readLaunchDocument = async (): Promise<DiscoveryLaunchDocument> => {
  const value: unknown = JSON.parse(Buffer.from(await readStdin()).toString("utf8"));
  if (!isDiscoveryLaunchDocument(value)) {
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

const makeHandler = (launch: DiscoveryLaunchDocument) =>
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
        getConnection: (_request, context) => {
          requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
          throw new ConnectError("connection unavailable", Code.Unimplemented);
        },
        getInfo: (_request, context) => {
          requireAuthorization(context.requestHeader.get("authorization"), launch.bearer);
          return { pluginInfo: jellyfinPluginInfo };
        },
      });
    },
  });

const startServer = async (launch: DiscoveryLaunchDocument): Promise<Server> => {
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
