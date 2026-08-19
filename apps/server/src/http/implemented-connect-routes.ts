import type { ConnectRouter } from "@connectrpc/connect";

import { AuthService } from "../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { ProviderService } from "../../../../gen/ts/src/nama/api/v1/provider_pb.js";
import { SetupService } from "../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import type { AuthenticationService } from "../authentication/authentication-service.ts";
import type { SetupCoordinatorService } from "../authentication/setup-coordinator.ts";
import type { ProviderManagementService } from "../provider/provider-management.ts";
import { createProviderServiceHandlers } from "./provider-rpc-handlers.ts";
import type { RequestRuntime } from "./request-runtime.ts";
import { createAuthServiceHandlers, createSetupServiceHandlers } from "./rpc-handlers.ts";

type ImplementedConnectRouteDependencies = Readonly<{
  readonly authentication: AuthenticationService;
  readonly requestRuntime: RequestRuntime;
  readonly providerManagement: ProviderManagementService;
  readonly setupCoordinator: SetupCoordinatorService;
}>;

const registerImplementedConnectRoutes = (
  router: ConnectRouter,
  {
    authentication,
    providerManagement,
    requestRuntime,
    setupCoordinator,
  }: ImplementedConnectRouteDependencies,
): void => {
  router.service(SetupService, createSetupServiceHandlers({ requestRuntime, setupCoordinator }));
  router.service(
    ProviderService,
    createProviderServiceHandlers({ providerManagement, requestRuntime }),
  );
  router.service(AuthService, createAuthServiceHandlers({ authentication, requestRuntime }));
};

export { registerImplementedConnectRoutes };
export type { ImplementedConnectRouteDependencies };
