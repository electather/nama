import { Buffer } from "node:buffer";

import { fromBinary } from "@bufbuild/protobuf";
import { RequestInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { HealthService } from "../../../../../gen/ts/src/nama/api/v1/health_pb.js";
import { SetupService } from "../../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import {
  CLIENT_REQUEST_ID,
  SERVER_REQUEST_ID,
  connectPath,
  createTestConnectRequestListener,
  dispatchConnectRequest,
  withEphemeralServer,
} from "./connect-dispatch.test-support.ts";

const BAD_REQUEST_STATUS = 400;
const EXPECTED_REQUEST_INFO_DETAIL_COUNT = 1;
const FIRST_REQUEST_INFO_DETAIL_INDEX = 0;

type ConnectErrorDetail = Readonly<{
  readonly type: string;
  readonly value: string;
}>;

type ConnectErrorResponse = Readonly<{
  readonly code: string;
  readonly details: readonly ConnectErrorDetail[];
}>;

const isConnectErrorDetail = (value: unknown): value is ConnectErrorDetail => {
  if (typeof value !== "object" || value === null || !("type" in value) || !("value" in value)) {
    return false;
  }
  return typeof value.type === "string" && typeof value.value === "string";
};

const isConnectErrorResponse = (value: unknown): value is ConnectErrorResponse => {
  if (typeof value !== "object" || value === null || !("code" in value) || !("details" in value)) {
    return false;
  }
  return (
    typeof value.code === "string" &&
    Array.isArray(value.details) &&
    value.details.every(isConnectErrorDetail)
  );
};

const readConnectError = async (response: Response): Promise<ConnectErrorResponse> => {
  const responseBody = await Effect.runPromise(Effect.promise<unknown>(() => response.json()));
  if (!isConnectErrorResponse(responseBody)) {
    throw new TypeError("expected a Connect error response");
  }
  return responseBody;
};

const expectRequestInfoCorrelation = (applicationError: ConnectErrorResponse): void => {
  const requestInfoDetails = applicationError.details.filter(
    (detail) => detail.type === RequestInfoSchema.typeName,
  );
  expect(requestInfoDetails).toHaveLength(EXPECTED_REQUEST_INFO_DETAIL_COUNT);
  const requestInfoDetail = requestInfoDetails[FIRST_REQUEST_INFO_DETAIL_INDEX];
  if (requestInfoDetail === undefined) {
    throw new TypeError("expected one RequestInfo detail");
  }
  const requestInfo = fromBinary(RequestInfoSchema, Buffer.from(requestInfoDetail.value, "base64"));
  expect(requestInfo.requestId).toBe(SERVER_REQUEST_ID);
};

const expectApplicationFailureCorrelation = async (origin: string): Promise<void> => {
  const response = await dispatchConnectRequest(
    origin,
    connectPath(HealthService, HealthService.method.check),
    { headers: { "nama-request-id": CLIENT_REQUEST_ID } },
  );
  expect(response.headers.get("nama-request-id")).toBe(SERVER_REQUEST_ID);
  const applicationError = await readConnectError(response);
  expect(applicationError.code).toBe("unauthenticated");
  expectRequestInfoCorrelation(applicationError);
};

const expectMalformedRequestCorrelation = async (origin: string): Promise<void> => {
  const response = await dispatchConnectRequest(
    origin,
    connectPath(SetupService, SetupService.method.getStatus),
    { body: "{" },
  );
  expect(response.status).toBe(BAD_REQUEST_STATUS);
  expect(response.headers.get("nama-request-id")).toBe(SERVER_REQUEST_ID);
};

test("uses server-owned correlation for application and decoder failures", async () => {
  const listener = createTestConnectRequestListener();
  await withEphemeralServer(listener, async (origin) => {
    await Promise.all([
      expectApplicationFailureCorrelation(origin),
      expectMalformedRequestCorrelation(origin),
    ]);
  });
});
