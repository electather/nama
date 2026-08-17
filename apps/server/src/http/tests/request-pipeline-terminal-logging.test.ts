import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { expect, test } from "vitest";

import { AuthService } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import {
  createRequestPipeline,
  getRequestAdministrator,
  getRequestId,
} from "../request-pipeline.ts";
import type { RequestPipelineDependencies } from "../request-pipeline.ts";
import { expectApplicationError } from "./request-pipeline-assertions.ts";
import {
  CONNECT_CODE_OK,
  REQUEST_ID,
  invoke,
  makeDependencies,
  makeMonotonicClock,
  responseFor,
  withRequestId,
} from "./request-pipeline-fixtures.ts";

const FIRST_TERMINAL_LOG_PARAMETER = 0;

type TerminalRecord = Parameters<
  RequestPipelineDependencies["terminalLog"]
>[typeof FIRST_TERMINAL_LOG_PARAMETER];

const FIRST_REQUEST_STARTED_AT = 100;
const FIRST_REQUEST_COMPLETED_AT = 117;
const FIRST_REQUEST_DURATION_MILLISECONDS = 17;
const SECOND_REQUEST_STARTED_AT = 10;
const SECOND_REQUEST_COMPLETED_AT = 12;
const SECOND_REQUEST_DURATION_MILLISECONDS = 2;
const THIRD_REQUEST_STARTED_AT = 20;
const THIRD_REQUEST_COMPLETED_AT = 25;
const THIRD_REQUEST_DURATION_MILLISECONDS = 5;
const MISSING_INVENTORY_METHOD_NAME = "NotInInventory";
const MISSING_INVENTORY_LOCAL_NAME = "notInInventory";

const recordTerminalEvent =
  (records: TerminalRecord[]) =>
  (record: TerminalRecord): void => {
    records.push(record);
  };

const makeTerminalLoggingDependencies = (
  records: TerminalRecord[],
  timestamps: readonly number[],
) =>
  makeDependencies({
    monotonicNow: makeMonotonicClock(timestamps),
    terminalLog: recordTerminalEvent(records),
  });

test("looks up the generated fully qualified method and recovers its server request ID", async () => {
  const records: TerminalRecord[] = [];
  const dependencies = makeTerminalLoggingDependencies(records, [
    FIRST_REQUEST_STARTED_AT,
    FIRST_REQUEST_COMPLETED_AT,
  ]);
  const request = withRequestId(AuthService.method.signIn, create(AuthService.method.signIn.input));
  const interceptor = createRequestPipeline(dependencies);

  await invoke(interceptor, request, (received) => {
    expect(getRequestId(received.contextValues)).toBe(REQUEST_ID);
    expect(getRequestAdministrator(received.contextValues)).toBeUndefined();
    return Promise.resolve(responseFor(received));
  });

  expect(records).toStrictEqual([
    {
      code: CONNECT_CODE_OK,
      durationMs: FIRST_REQUEST_DURATION_MILLISECONDS,
      event: "rpc.completed",
      method: "nama.api.v1.AuthService.SignIn",
      requestId: REQUEST_ID,
    },
  ]);
});

test("emits one allowlisted terminal record with accurate success and failure codes", async () => {
  const records: TerminalRecord[] = [];
  const dependencies = makeTerminalLoggingDependencies(records, [
    SECOND_REQUEST_STARTED_AT,
    SECOND_REQUEST_COMPLETED_AT,
    THIRD_REQUEST_STARTED_AT,
    THIRD_REQUEST_COMPLETED_AT,
  ]);
  const interceptor = createRequestPipeline(dependencies);
  const successRequest = withRequestId(
    AuthService.method.signIn,
    create(AuthService.method.signIn.input),
  );
  const deniedMethod = Object.freeze({
    ...AuthService.method.signIn,
    localName: MISSING_INVENTORY_LOCAL_NAME,
    name: MISSING_INVENTORY_METHOD_NAME,
  });

  await invoke(interceptor, successRequest);
  const failurePromise = invoke(
    interceptor,
    withRequestId(deniedMethod, create(deniedMethod.input)),
  );
  await expectApplicationError({
    code: Code.PermissionDenied,
    promise: failurePromise,
    reason: "PERMISSION_DENIED",
  });

  expect(records).toStrictEqual([
    {
      code: CONNECT_CODE_OK,
      durationMs: SECOND_REQUEST_DURATION_MILLISECONDS,
      event: "rpc.completed",
      method: "nama.api.v1.AuthService.SignIn",
      requestId: REQUEST_ID,
    },
    {
      code: Code.PermissionDenied,
      durationMs: THIRD_REQUEST_DURATION_MILLISECONDS,
      event: "rpc.completed",
      method: "nama.api.v1.AuthService.NotInInventory",
      requestId: REQUEST_ID,
    },
  ]);
});
