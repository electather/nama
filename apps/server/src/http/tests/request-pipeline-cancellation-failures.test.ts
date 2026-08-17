import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { expect, test } from "vitest";

import { AuthService } from "../../../../../gen/ts/src/nama/api/v1/auth_pb.js";
import { createRequestPipeline } from "../request-pipeline.ts";
import { expectApplicationError } from "./request-pipeline-assertions.ts";
import {
  invoke,
  makeDependencies,
  makeTestRequestRuntime,
  responseFor,
  withRequestId,
} from "./request-pipeline-fixtures.ts";

const PUBLIC_ERROR_MESSAGE = "The request could not be completed.";
const REQUEST_RUNTIME_INTERRUPTED = Object.freeze({ _tag: "RequestRuntimeInterrupted" as const });
const EXPECTED_SIGNAL_ERROR = "Expected a request signal.";
const HANDLER_FAILURE_ERROR = "Unexpected handler failure.";
const DEADLINE_EXCEEDED_MESSAGE = "Request deadline exceeded.";

const makeInterruptedRequestRuntime = () =>
  makeTestRequestRuntime((_effect, signal) => {
    if (signal === undefined) {
      return Promise.reject(new Error(EXPECTED_SIGNAL_ERROR));
    }
    const interrupted = Promise.withResolvers<never>();
    signal.addEventListener(
      "abort",
      () => {
        interrupted.reject(REQUEST_RUNTIME_INTERRUPTED);
      },
      { once: true },
    );
    return interrupted.promise;
  });

test("normalizes a validator defect to INTERNAL without invoking the handler", async () => {
  let dispatched = false;
  const requestValidator = {
    validate: () => ({ kind: "defect" as const }),
  };

  const promise = invoke(
    createRequestPipeline(makeDependencies({ requestValidator })),
    withRequestId(AuthService.method.signIn, create(AuthService.method.signIn.input)),
    (received) => {
      dispatched = true;
      return Promise.resolve(responseFor(received));
    },
  );
  const error = await expectApplicationError({
    code: Code.Internal,
    promise,
    reason: "INTERNAL",
  });

  expect(dispatched).toBe(false);
  expect(error.rawMessage).toBe(PUBLIC_ERROR_MESSAGE);
});

test("passes the exact active Connect request signal to RequestRuntime", async () => {
  const controller = new AbortController();
  const receivedSignals: AbortSignal[] = [];
  const requestRuntime = makeTestRequestRuntime((effect, signal) => {
    if (signal === undefined) {
      return Promise.reject(new Error(EXPECTED_SIGNAL_ERROR));
    }
    receivedSignals.push(signal);
    return Effect.runPromise(effect);
  });
  const request = withRequestId(
    AuthService.method.signIn,
    create(AuthService.method.signIn.input),
    {
      signal: controller.signal,
    },
  );

  await invoke(createRequestPipeline(makeDependencies({ requestRuntime })), request);

  expect(receivedSignals).toStrictEqual([controller.signal]);
});

test("maps interruption from the active request signal without consulting unrelated signal state", async () => {
  const unrelatedDeadline = new AbortController();
  unrelatedDeadline.abort(new ConnectError(DEADLINE_EXCEEDED_MESSAGE, Code.DeadlineExceeded));
  const controller = new AbortController();
  const requestRuntime = makeInterruptedRequestRuntime();
  const invocation = invoke(
    createRequestPipeline(makeDependencies({ requestRuntime })),
    withRequestId(AuthService.method.signIn, create(AuthService.method.signIn.input), {
      signal: controller.signal,
    }),
  );
  controller.abort();

  await expectApplicationError({
    code: Code.Canceled,
    promise: invocation,
    reason: "REQUEST_CANCELLED",
  });
});

test("maps a deadline indication on the active request signal to DEADLINE_EXCEEDED", async () => {
  const controller = new AbortController();
  const requestRuntime = makeInterruptedRequestRuntime();
  const invocation = invoke(
    createRequestPipeline(makeDependencies({ requestRuntime })),
    withRequestId(AuthService.method.signIn, create(AuthService.method.signIn.input), {
      signal: controller.signal,
    }),
  );
  controller.abort(new ConnectError(DEADLINE_EXCEEDED_MESSAGE, Code.DeadlineExceeded));

  await expectApplicationError({
    code: Code.DeadlineExceeded,
    promise: invocation,
    reason: "DEADLINE_EXCEEDED",
  });
});

test("normalizes an unhandled handler defect to INTERNAL with the public error shape", async () => {
  const promise = invoke(
    createRequestPipeline(makeDependencies()),
    withRequestId(AuthService.method.signIn, create(AuthService.method.signIn.input)),
    () => Promise.reject(new Error(HANDLER_FAILURE_ERROR)),
  );
  const error = await expectApplicationError({
    code: Code.Internal,
    promise,
    reason: "INTERNAL",
  });

  expect(error.rawMessage).toBe(PUBLIC_ERROR_MESSAGE);
});
