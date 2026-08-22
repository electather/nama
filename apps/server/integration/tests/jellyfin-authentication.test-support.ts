import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { WatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";
import { Effect } from "effect";

const TEMPORARY_DIRECTORY_PREFIX = "np-";
const SINGLE_ITEM_COUNT = 1;

const acquireTemporaryPluginDirectory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), TEMPORARY_DIRECTORY_PREFIX))),
  (temporaryDirectory) =>
    Effect.promise(() => rm(temporaryDirectory, { force: true, recursive: true })),
);

const findPluginSocket = (temporaryDirectory: string) =>
  Effect.promise(async () => {
    const paths = await readdir(temporaryDirectory, { recursive: true });
    const relativeSocketPath = paths.find((path) => path.endsWith(".sock"));
    if (relativeSocketPath === undefined) {
      throw new Error("Jellyfin plugin socket was absent");
    }
    return join(temporaryDirectory, relativeSocketPath);
  });

const unauthenticatedWatchStateCodes = (socketPath: string) =>
  Effect.promise(async () => {
    const client = createClient(
      WatchStateService,
      createConnectTransport({
        baseUrl: "http://localhost",
        httpVersion: "1.1",
        nodeOptions: { socketPath },
      }),
    );
    const results = await Promise.allSettled([
      client.listWatchStates({
        scan: { case: "begin", value: { pageSize: SINGLE_ITEM_COUNT } },
      }),
      client.getWatchStates({ itemReferences: [] }),
      client.pushWatchStates({
        batchId: "authentication-batch",
        mutations: [
          {
            itemReference: { itemId: "authentication-item" },
            mutationId: "authentication-mutation",
            target: { case: "setWatched", value: { watched: true } },
          },
        ],
      }),
    ]);
    return results.map((result) => {
      if (result.status !== "rejected") {
        throw new Error("Unauthenticated Jellyfin RPC unexpectedly succeeded");
      }
      return ConnectError.from(result.reason).code;
    });
  });

export { acquireTemporaryPluginDirectory, findPluginSocket, unauthenticatedWatchStateCodes };
