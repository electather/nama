import { once } from "node:events";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";

import { Effect, Option } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import type { SetupCoordinatorService } from "../../authentication/setup-coordinator.ts";
import type { RequestValidator } from "../../contracts/request-validation.ts";
import type { ProviderManagementService } from "../../provider/provider-management.ts";
import { createConnectRequestListener } from "../connect-dispatch.ts";
import type { ConnectRequestListenerDependencies } from "../connect-dispatch.ts";
import type { RequestRuntime } from "../request-runtime.ts";
import { EPHEMERAL_PORT, HOST, HTTP_NOT_FOUND } from "./network.test-support.ts";

const SERVER_REQUEST_ID = "00000000-0000-4000-8000-000000000001";
const CLIENT_REQUEST_ID = "client-controlled-request-id";
const DUMMY_AUTHORIZATION = "Bearer test.signed-bearer";
const DUMMY_EMAIL = "administrator@nama.test";
const TEST_MONOTONIC_TIME = 0;
const ADMINISTRATOR = Object.freeze({
  displayName: "Test Administrator",
  email: DUMMY_EMAIL,
  id: "test-administrator",
});
const noRateLimit: Effect.Effect<number | undefined> = Effect.succeed(
  Option.getOrUndefined(Option.none<number>()),
);
const validRequestValidation: { readonly kind: "valid" } = Object.freeze({ kind: "valid" });

const requestRuntime = Object.freeze({
  awaitRequests: Effect.void,
  interruptRequests: Effect.void,
  run: (effect, onExit) => {
    void effect;
    void onExit;
  },
  runPromise: <Success, Failure>(effect: Effect.Effect<Success, Failure>): Promise<Success> =>
    Effect.runPromise(effect),
} satisfies RequestRuntime);

const authentication: AuthenticationService = Object.freeze({
  approveDeviceAuthorization: () => Effect.die("device approval is outside dispatch coverage"),
  consumeGlobalSignInBudget: noRateLimit,
  consumeIdentitySignInBudget: () => noRateLimit,
  resolveAdministrator: () => Effect.succeed(ADMINISTRATOR),
  resolveConsumerPrincipal: () => Effect.succeed(ADMINISTRATOR),
  resolvePrincipal: () => Effect.succeed(ADMINISTRATOR),
  revokeAppleClientRefreshTokens: Effect.die(
    "Apple client revocation is outside dispatch coverage",
  ),
  signIn: () =>
    Effect.succeed({
      administrator: ADMINISTRATOR,
      bearer: "test.signed-bearer",
      sessionExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    }),
  signOut: () => Effect.void,
});
const catalogQuery: ConnectRequestListenerDependencies["catalogQuery"] = Object.freeze({
  getHome: () => Effect.die("catalog home read is outside dispatch coverage"),
  getMedia: () => Effect.die("catalog media read is outside dispatch coverage"),
  getMediaSource: () => Effect.die("catalog source read is outside dispatch coverage"),
  listChildren: () => Effect.die("catalog children list is outside dispatch coverage"),
  listLibrary: () => Effect.die("catalog library list is outside dispatch coverage"),
  resolveArtwork: () => Effect.die("catalog artwork resolution is outside dispatch coverage"),
  search: () => Effect.die("catalog search is outside dispatch coverage"),
});

const setupCoordinator: SetupCoordinatorService = Object.freeze({
  createAdministrator: () => Effect.die("administrator creation is outside dispatch coverage"),
  getStatus: Effect.succeed(true),
});

const providerManagement: ProviderManagementService = Object.freeze({
  createProviderInstance: () => Effect.die("provider creation is outside dispatch coverage"),
  deleteProviderInstance: () => Effect.die("provider deletion is outside dispatch coverage"),
  getProviderInstance: () => Effect.die("provider read is outside dispatch coverage"),
  listProviderInstances: () => Effect.die("provider list is outside dispatch coverage"),
  listProviderTypes: () =>
    Effect.succeed({
      nextPageToken: "",
      providerTypes: [],
    }),
  runProviderActivity: <Success, Failure, Requirements>(
    _providerInstanceId: string,
    activity: Effect.Effect<Success, Failure, Requirements>,
  ) => activity,
  testProviderConfiguration: () =>
    Effect.die("provider configuration test is outside dispatch coverage"),
  testProviderInstance: () => Effect.die("provider instance test is outside dispatch coverage"),
  updateProviderInstance: () => Effect.die("provider update is outside dispatch coverage"),
});

const requestValidator: RequestValidator = Object.freeze({
  validate: () => validRequestValidation,
});

const createTestConnectRequestListener = (
  selectedProviderManagement: ProviderManagementService = providerManagement,
): RequestListener =>
  createConnectRequestListener({
    authentication,
    catalogQuery,
    monotonicNow: () => TEST_MONOTONIC_TIME,
    providerManagement: selectedProviderManagement,
    requestIdFactory: () => SERVER_REQUEST_ID,
    requestRuntime,
    requestValidator,
    setupCoordinator,
    terminalLog: (record) => {
      void record;
    },
  });

const connectPath = (
  service: Readonly<{ readonly typeName: string }>,
  method: Readonly<{ readonly name: string }>,
): string => `/${service.typeName}/${method.name}`;

type DispatchRequestOptions = Readonly<{
  readonly body?: BodyInit;
  readonly headers?: HeadersInit;
}>;

const dispatchConnectRequest = (
  origin: string,
  path: string,
  options?: DispatchRequestOptions,
): Promise<Response> => {
  const headers = new Headers(options?.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(new URL(path, origin), {
    body: options?.body ?? "{}",
    headers,
    method: "POST",
  });
};

const withEphemeralServer = async <ResponseValue>(
  listener: RequestListener,
  use: (origin: string) => Promise<ResponseValue>,
): Promise<ResponseValue> => {
  const server = createServer(listener);
  try {
    server.listen(EPHEMERAL_PORT, HOST);
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new TypeError("expected an internet socket");
    }
    return await use(`http://${HOST}:${address.port}`);
  } finally {
    await server[Symbol.asyncDispose]();
  }
};

export {
  CLIENT_REQUEST_ID,
  DUMMY_AUTHORIZATION,
  HTTP_NOT_FOUND,
  SERVER_REQUEST_ID,
  connectPath,
  createTestConnectRequestListener,
  dispatchConnectRequest,
  withEphemeralServer,
};

export type { DispatchRequestOptions };
