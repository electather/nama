import { performance } from "node:perf_hooks";

import { Effect } from "effect";

import { Authentication } from "../authentication/authentication-service.ts";
import { SetupCoordinator } from "../authentication/setup-coordinator.ts";
import { CatalogQuery } from "../catalog/catalog-query-live.ts";
import { createRequestValidator } from "../contracts/request-validation.ts";
import { logRpcCompletion } from "../logging/logging.ts";
import { ProviderManagement } from "../provider/provider-management.ts";
import { createConnectRequestListener } from "./connect-dispatch.ts";
import type { RequestRuntime } from "./request-runtime.ts";

const makeConnectRequestListener = (requestRuntime: RequestRuntime) =>
  Effect.gen(function* makeConnectRequestListenerEffect() {
    const authentication = yield* Authentication;
    const catalogQuery = yield* CatalogQuery;
    const setupCoordinator = yield* SetupCoordinator;
    const providerManagement = yield* ProviderManagement;
    const requestValidator = createRequestValidator();
    return createConnectRequestListener({
      authentication,
      catalogQuery,
      monotonicNow: () => performance.now(),
      providerManagement,
      requestRuntime,
      requestValidator,
      setupCoordinator,
      terminalLog: (record) => requestRuntime.runPromise(logRpcCompletion(record)),
    });
  });

export { makeConnectRequestListener };
