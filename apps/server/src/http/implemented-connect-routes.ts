import type { ConnectRouter } from "@connectrpc/connect";

import { AuthService } from "../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { SetupService } from "../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import type { AuthenticationService } from "../authentication/authentication-service.ts";
import type { SetupCoordinatorService } from "../authentication/setup-coordinator.ts";
import type { RequestRuntime } from "./request-runtime.ts";
import { createAuthServiceHandlers, createSetupServiceHandlers } from "./rpc-handlers.ts";

type ImplementedConnectRouteDependencies = Readonly<{
  readonly authentication: AuthenticationService;
  readonly requestRuntime: RequestRuntime;
  readonly setupCoordinator: SetupCoordinatorService;
}>;

const registerImplementedConnectRoutes = (
  router: ConnectRouter,
  { authentication, requestRuntime, setupCoordinator }: ImplementedConnectRouteDependencies,
): void => {
  router.service(SetupService, createSetupServiceHandlers({ requestRuntime, setupCoordinator }));
  router.service(AuthService, createAuthServiceHandlers({ authentication, requestRuntime }));
};

export { registerImplementedConnectRoutes };
export type { ImplementedConnectRouteDependencies };
