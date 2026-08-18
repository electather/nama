// oxlint-disable -- Disposable executable fixture intentionally uses dynamic Node process and Connect handler values.
// fallow-ignore-file unused-file -- Disposable subprocess is launched by integration tests through a fixed executable descriptor.
import { chmod } from "node:fs/promises";
import { createServer } from "node:http";

import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";

import { HealthService, ServingStatus } from "../../../../gen/ts/src/nama/plugin/v1/health_pb.js";
import { PluginService } from "../../../../gen/ts/src/nama/plugin/v1/plugin_pb.js";

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
// fallow-ignore-next-line complexity -- The disposable fixture intentionally contains all lifecycle modes used by the real-process tests.
process.stdin.once("end", async () => {
  let envelope;
  try {
    envelope = JSON.parse(chunks.join(""));
  } catch {
    process.exitCode = 2;
    return;
  }

  const socketPath = envelope.socket_path;
  const bearer = envelope.bearer;
  const args = new Set(process.argv.slice(2));
  const providerTypeId = args.has("--wrong-provider") ? "other" : "fixture";
  const contractMajor = args.has("--wrong-major") ? 2 : 1;
  const probeDescription = args.has("--env-probe")
    ? Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING").length === 0 &&
      !Object.values(process.env).includes(bearer) &&
      !process.argv.includes(bearer)
      ? ""
      : "ambient-data-present"
    : "";
  if (args.has("--exit-before-socket")) {
    process.exitCode = 17;
    return;
  }

  const authorize = (context) => {
    if (context.requestHeader.get("authorization") !== `Bearer ${bearer}`) {
      throw new ConnectError("unauthenticated", Code.Unauthenticated);
    }
  };
  const waitForCancellation = (context) =>
    new Promise((resolve) => {
      if (context.signal.aborted) {
        resolve();
        return;
      }
      context.signal.addEventListener("abort", resolve, { once: true });
    });

  const handler = connectNodeAdapter({
    connect: true,
    grpc: false,
    grpcWeb: false,
    routes: (router) => {
      router.service(HealthService, {
        check: (_request, context) => {
          authorize(context);
          return { status: ServingStatus.SERVING };
        },
      });
      router.service(PluginService, {
        getInfo: async (_request, context) => {
          authorize(context);
          if (args.has("--block")) {
            await waitForCancellation(context);
            throw new ConnectError("cancelled", Code.Canceled);
          }
          return {
            pluginInfo: {
              providerTypeId,
              displayName: "Disposable fixture",
              description: probeDescription,
              buildVersion: "test",
              contractMajor,
              capabilities: [],
              configurationSchema: {},
              schemaProfileVersion: 1,
              schemaRevision: "test",
            },
          };
        },
        getConnection: async (_request, context) => {
          authorize(context);
          if (args.has("--block-call")) {
            await waitForCancellation(context);
            throw new ConnectError("cancelled", Code.Canceled);
          }
          return { connection: { status: 1, capabilities: [] } };
        },
      });
    },
  });
  const server = createServer(handler);
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });
  process.once("SIGTERM", async () => {
    if (args.has("--stubborn")) {
      return;
    }
    await close();
    process.exit(0);
  });
  process.once("SIGINT", async () => {
    await close();
    process.exit(0);
  });

  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o600);
    if (args.has("--stderr")) {
      process.stderr.write('{"event":"fixture.connected","level":"info","attempt":1}\n');
      process.stderr.write("raw provider failure\n");
    }
    if (args.has("--crash-after-ready")) {
      setTimeout(() => process.kill(process.pid, "SIGKILL"), 100);
    }
  });
});
