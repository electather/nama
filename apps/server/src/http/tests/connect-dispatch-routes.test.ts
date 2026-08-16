import { expect, test } from "vitest";

import {
  connectProtocolProbePath,
  publicConnectRepresentativeRoutes,
} from "./connect-dispatch-routes.test-support.ts";
import {
  DUMMY_AUTHORIZATION,
  HTTP_NOT_FOUND,
  SERVER_REQUEST_ID,
  createTestConnectRequestListener,
  dispatchConnectRequest,
  withEphemeralServer,
} from "./connect-dispatch.test-support.ts";

const UNSUPPORTED_MEDIA_TYPE_STATUS = 415;
const UNIMPLEMENTED_CONNECT_CODE = '"code":"unimplemented"';
const PRIVATE_PLUGIN_PATH = "/nama.plugin.v1.HealthService/Check";
const BETTER_AUTH_PATH = "/api/auth/sign-in/email";
const UNKNOWN_PATH = "/unknown-path";
const UNREGISTERED_PATHS = [PRIVATE_PLUGIN_PATH, BETTER_AUTH_PATH, UNKNOWN_PATH];
const UNSUPPORTED_MEDIA_TYPES = ["application/grpc+proto", "application/grpc-web+proto"];

const expectRegisteredPublicServices = async (origin: string): Promise<void> => {
  const results = await Promise.all(
    publicConnectRepresentativeRoutes.map(async (route) => {
      const response = await dispatchConnectRequest(origin, route.path, {
        body: route.body,
        headers: { authorization: DUMMY_AUTHORIZATION },
      });
      return { body: await response.text(), response, route };
    }),
  );
  for (const { body, response, route } of results) {
    expect(response.status).not.toBe(HTTP_NOT_FOUND);
    expect(response.headers.get("nama-request-id")).toBe(SERVER_REQUEST_ID);
    if (route.expectsUnimplemented) {
      expect(body).toContain(UNIMPLEMENTED_CONNECT_CODE);
    }
  }
};

const expectUnregisteredPaths = async (origin: string): Promise<void> => {
  const responses = await Promise.all(
    UNREGISTERED_PATHS.map((path) => dispatchConnectRequest(origin, path)),
  );
  for (const response of responses) {
    expect(response.status).toBe(HTTP_NOT_FOUND);
    expect(response.headers.get("nama-request-id")).toBe(SERVER_REQUEST_ID);
  }
};

const expectConnectOnlyProtocol = async (origin: string): Promise<void> => {
  const responses = await Promise.all(
    UNSUPPORTED_MEDIA_TYPES.map((contentType) =>
      dispatchConnectRequest(origin, connectProtocolProbePath, {
        headers: { "content-type": contentType },
      }),
    ),
  );
  for (const response of responses) {
    expect(response.status).toBe(UNSUPPORTED_MEDIA_TYPE_STATUS);
    expect(response.headers.get("nama-request-id")).toBe(SERVER_REQUEST_ID);
  }
};

test("registers only public Connect service paths and protocol", async () => {
  const listener = createTestConnectRequestListener();
  await withEphemeralServer(listener, async (origin) => {
    await expectRegisteredPublicServices(origin);
    await expectUnregisteredPaths(origin);
    await expectConnectOnlyProtocol(origin);
  });
});
