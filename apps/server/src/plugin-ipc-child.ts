// oxlint-disable eslint/func-style, eslint/max-lines-per-function, eslint/max-statements, eslint/sort-imports, import/no-nodejs-modules, promise/avoid-new, typescript/prefer-readonly-parameter-types -- Disposable Node subprocess fixture adapts callback transports and mutable Node resources.
import { createHash, timingSafeEqual } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import { MediaKind } from "@nama/api/nama/plugin/v1/media_pb.js";

interface Bootstrap {
  readonly socketPath: string;
  readonly bearer: string;
  readonly getItemDelayMs: number;
}

const MAX_BOOTSTRAP_BYTES = 4096;
const MIN_BEARER_LENGTH = 43;
const MIN_DELAY_MS = 1;
const MAX_DELAY_MS = 1000;
const FIXTURE_ITEM_REFERENCE = "ipc-spike-item";
const FIXTURE_TITLE = "IPC Lifecycle Fixture";

function bearerMatches(expected: string, presented: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const presentedDigest = createHash("sha256").update(presented).digest();
  return timingSafeEqual(expectedDigest, presentedDigest);
}

function authenticationInterceptor(expectedBearer: string): Interceptor {
  return (next) => (request) => {
    const authorization = request.header.get("authorization");
    let presented = "";
    if (authorization?.startsWith("Bearer ") === true) {
      presented = authorization.slice("Bearer ".length);
    }
    if (!bearerMatches(expectedBearer, presented)) {
      throw new ConnectError("plugin authentication failed", Code.Unauthenticated);
    }
    return next(request);
  };
}

async function readBootstrap(): Promise<Bootstrap> {
  process.stdin.setEncoding("utf8");
  let body = "";
  for await (const chunk of process.stdin) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BOOTSTRAP_BYTES) {
      throw new Error("plugin bootstrap invalid");
    }
  }

  const value: unknown = JSON.parse(body);
  if (
    typeof value !== "object" ||
    value === null ||
    !("socketPath" in value) ||
    !("bearer" in value) ||
    !("getItemDelayMs" in value)
  ) {
    throw new Error("plugin bootstrap invalid");
  }

  const socketPath: unknown = value["socketPath"];
  const bearer: unknown = value["bearer"];
  const getItemDelayMs: unknown = value["getItemDelayMs"];
  if (
    typeof socketPath !== "string" ||
    !isAbsolute(socketPath) ||
    typeof bearer !== "string" ||
    bearer.length < MIN_BEARER_LENGTH ||
    typeof getItemDelayMs !== "number" ||
    !Number.isInteger(getItemDelayMs) ||
    getItemDelayMs < MIN_DELAY_MS ||
    getItemDelayMs > MAX_DELAY_MS
  ) {
    throw new Error("plugin bootstrap invalid");
  }

  return { bearer, getItemDelayMs, socketPath };
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = () => {
      server.off("listening", onListening);
      reject(new Error("plugin socket bind failed"));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

async function close(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(new Error("plugin shutdown failed"));
      }
    });
  });
  await rm(socketPath, { force: true });
}

async function main(): Promise<void> {
  const bootstrap = await readBootstrap();
  const handler = connectNodeAdapter({
    interceptors: [authenticationInterceptor(bootstrap.bearer)],
    routes: (router) => {
      router.service(HealthService, {
        check: () => ({ status: ServingStatus.SERVING }),
      });
      router.service(LibraryService, {
        getItem: async (request, context) => {
          if (request.itemReference?.itemId !== FIXTURE_ITEM_REFERENCE) {
            throw new ConnectError("provider item not found", Code.NotFound);
          }
          try {
            await delay(bootstrap.getItemDelayMs, undefined, { signal: context.signal });
          } catch {
            if (context.signal.reason instanceof ConnectError) {
              throw context.signal.reason;
            }
            throw new ConnectError("plugin operation cancelled", Code.Canceled);
          }
          return {
            item: {
              itemReference: { itemId: FIXTURE_ITEM_REFERENCE },
              kind: MediaKind.MOVIE,
              kindDetails: { case: "movie", value: {} },
              title: FIXTURE_TITLE,
            },
          };
        },
      });
    },
  });
  const server = createServer(handler);
  let stopping = false;

  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await close(server, bootstrap.socketPath);
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    } finally {
      if (process.connected) {
        process.disconnect();
      }
    }
  };

  process.once("SIGTERM", () => {
    void stop();
  });
  await listen(server, bootstrap.socketPath);
  process.send?.({ type: "ready" });
}

try {
  await main();
} catch {
  if (process.connected) {
    process.disconnect();
  }
  process.exitCode = 1;
}
