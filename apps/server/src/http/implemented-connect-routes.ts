import type { ConnectRouter } from "@connectrpc/connect";

import { registerLibraryConnectRoutes } from "./library-rpc-handlers.ts";
import type { LibraryServiceHandlerDependencies } from "./library-rpc-handlers.ts";
import { registerProviderConnectRoutes } from "./provider-rpc-handlers.ts";
import type { ProviderServiceHandlerDependencies } from "./provider-rpc-handlers.ts";
import { registerAuthSetupConnectRoutes } from "./rpc-handlers.ts";
import type {
  AuthServiceHandlerDependencies,
  SetupServiceHandlerDependencies,
} from "./rpc-handlers.ts";

type ImplementedConnectRouteDependencies = AuthServiceHandlerDependencies &
  LibraryServiceHandlerDependencies &
  ProviderServiceHandlerDependencies &
  SetupServiceHandlerDependencies;

const registerImplementedConnectRoutes = (
  router: ConnectRouter,
  dependencies: ImplementedConnectRouteDependencies,
): void => {
  registerAuthSetupConnectRoutes(router, dependencies);
  registerLibraryConnectRoutes(router, dependencies);
  registerProviderConnectRoutes(router, dependencies);
};
export { registerImplementedConnectRoutes };
export type { ImplementedConnectRouteDependencies };
