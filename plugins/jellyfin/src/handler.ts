import { timingSafeEqual } from "node:crypto";

import { Code, ConnectError } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { HealthService, ServingStatus } from "@nama/api/nama/plugin/v1/health_pb.js";

import type { LaunchDocument } from "./launch-document.ts";
import { registerJellyfinLibraryService } from "./library-service.ts";
import { registerJellyfinPluginService } from "./plugin-service.ts";
import { registerJellyfinWatchStateService } from "./watch-state-service.ts";

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

const makeJellyfinHandler = (launch: LaunchDocument) =>
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
      registerJellyfinLibraryService(router, launch, requireAuthorization);
      registerJellyfinPluginService(router, launch, requireAuthorization);
      registerJellyfinWatchStateService(router, launch, requireAuthorization);
    },
  });

export { makeJellyfinHandler };
