import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { Effect } from "effect";
import { expect, test } from "vitest";

import {
  CreateAdministratorRequestSchema,
  GetStatusRequestSchema,
  SetupService,
} from "../../../../../gen/ts/src/nama/api/v1/setup_pb.js";
import { createSetupServiceHandlers } from "../rpc-handlers.ts";
import {
  ADMINISTRATOR,
  ADMINISTRATOR_MESSAGE,
  makeHandlerContext,
  makeRpcRequestRuntime,
  makeRpcSetupCoordinator,
  required,
} from "./rpc-handlers.test-support.ts";

const UNINITIALIZED_STATUS = false;
const INITIALIZED_STATUS = true;
const CREATE_ADMINISTRATOR_INPUT = Object.freeze({
  bootstrapToken: "bootstrap-token",
  displayName: "Nama Administrator",
  email: "administrator@nama.example",
  password: "correct horse battery staple",
});

const makeStatusFixture = () => {
  let initialized = UNINITIALIZED_STATUS;
  const receivedSignals: AbortSignal[] = [];
  const handlers: Partial<ServiceImpl<typeof SetupService>> = createSetupServiceHandlers({
    requestRuntime: makeRpcRequestRuntime(receivedSignals),
    setupCoordinator: makeRpcSetupCoordinator({
      getStatus: Effect.sync(() => initialized),
    }),
  });
  const getStatus = required(handlers.getStatus);
  const uninitializedContext = makeHandlerContext({
    method: SetupService.method.getStatus,
    service: SetupService,
    signal: new AbortController().signal,
  });
  const initializedContext = makeHandlerContext({
    method: SetupService.method.getStatus,
    service: SetupService,
    signal: new AbortController().signal,
  });

  return Object.freeze({
    expectedSignals: [uninitializedContext.signal, initializedContext.signal],
    getStatus,
    initializedContext,
    initializedRequest: create(GetStatusRequestSchema),
    markInitialized: () => {
      initialized = INITIALIZED_STATUS;
    },
    receivedSignals,
    uninitializedContext,
    uninitializedRequest: create(GetStatusRequestSchema),
  });
};

const makeCreateAdministratorFixture = () => {
  const receivedRequests: unknown[] = [];
  const receivedSignals: AbortSignal[] = [];
  const handlers: Partial<ServiceImpl<typeof SetupService>> = createSetupServiceHandlers({
    requestRuntime: makeRpcRequestRuntime(receivedSignals),
    setupCoordinator: makeRpcSetupCoordinator({
      createAdministrator: (request) =>
        Effect.sync(() => {
          receivedRequests.push(request);
          return ADMINISTRATOR;
        }),
    }),
  });
  const createAdministrator = required(handlers.createAdministrator);
  const context = makeHandlerContext({
    method: SetupService.method.createAdministrator,
    service: SetupService,
    signal: new AbortController().signal,
  });

  return Object.freeze({
    context,
    createAdministrator,
    receivedRequests,
    receivedSignals,
    request: create(CreateAdministratorRequestSchema, CREATE_ADMINISTRATOR_INPUT),
  });
};

test("returns the current process setup state through the HandlerContext request runtime", async () => {
  const fixture = makeStatusFixture();
  const uninitializedResponse = await fixture.getStatus(
    fixture.uninitializedRequest,
    fixture.uninitializedContext,
  );
  fixture.markInitialized();
  const initializedResponse = await fixture.getStatus(
    fixture.initializedRequest,
    fixture.initializedContext,
  );

  expect([uninitializedResponse, initializedResponse]).toStrictEqual([
    { initialized: UNINITIALIZED_STATUS },
    { initialized: INITIALIZED_STATUS },
  ]);
  expect(fixture.receivedSignals).toStrictEqual(fixture.expectedSignals);
});

test("forwards the complete setup request and returns only the Nama administrator", async () => {
  const fixture = makeCreateAdministratorFixture();
  const response = await fixture.createAdministrator(fixture.request, fixture.context);

  expect(fixture.receivedRequests).toStrictEqual([CREATE_ADMINISTRATOR_INPUT]);
  expect(response).toStrictEqual({ administrator: ADMINISTRATOR_MESSAGE });
  expect(fixture.receivedSignals).toStrictEqual([fixture.context.signal]);
});
