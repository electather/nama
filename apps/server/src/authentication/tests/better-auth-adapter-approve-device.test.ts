import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  AUTHORIZATION,
  FIRST_CALL,
  expectSafeFailure,
  makeAdapter,
  makeBehaviorPrivateError,
  makeBehaviorRuntimeFakes,
  rejectedPlan,
  resolvedPlan,
} from "./better-auth-adapter-behavior.test-support.ts";

const USER_CODE = "ABCD-EFGH";
const deviceAuthorizationError = (error: string, description: string): Error =>
  Object.assign(makeBehaviorPrivateError(), {
    body: { error, error_description: description },
  });

const requireObject = (value: unknown): object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Better Auth call must be an object");
  }
  return value;
};

it.effect("verifies then approves the user code with the same authenticated session context", () =>
  // oxlint-disable-next-line eslint/max-statements -- One assertion block proves ordered verification, approval, shared headers, and safe input projection.
  Effect.gen(function* approveDeviceAuthorizationTest() {
    const fakes = makeBehaviorRuntimeFakes();
    const adapter = yield* makeAdapter(fakes);
    yield* adapter.approveDeviceAuthorization(AUTHORIZATION, USER_CODE);

    expect(fakes.callOrder).toStrictEqual(["deviceVerify", "deviceApprove"]);
    const verifyCall = requireObject(fakes.captures.deviceVerify[FIRST_CALL]);
    const approveCall = requireObject(fakes.captures.deviceApprove[FIRST_CALL]);
    expect(Reflect.get(verifyCall, "query")).toStrictEqual({ user_code: USER_CODE });
    expect(Reflect.get(approveCall, "body")).toStrictEqual({ userCode: USER_CODE });
    const headers: unknown = Reflect.get(verifyCall, "headers");
    expect(headers).toBe(Reflect.get(approveCall, "headers"));
    if (!(headers instanceof Headers)) {
      throw new TypeError("Better Auth approval headers are missing");
    }
    expect([...headers.entries()]).toStrictEqual([["authorization", AUTHORIZATION]]);
  }),
);

const rejectionCases = [
  [
    "an invalid user code",
    "deviceVerify",
    "invalid_request",
    "Invalid user code",
    "DeviceAuthorizationCodeInvalid",
  ],
  [
    "an expired user code",
    "deviceVerify",
    "expired_token",
    "User code has expired",
    "DeviceAuthorizationExpired",
  ],
  [
    "an already processed authorization",
    "deviceApprove",
    "invalid_request",
    "Device code already processed",
    "DeviceAuthorizationAlreadyProcessed",
  ],
  [
    "a session-mismatched authorization",
    "deviceApprove",
    "access_denied",
    "not authorized",
    "DeviceAuthorizationAccessDenied",
  ],
  [
    "an invalid internal session",
    "deviceVerify",
    "unauthorized",
    "Authentication required",
    "InvalidBearer",
  ],
] as const;

for (const [description, method, error, errorDescription, expectedTag] of rejectionCases) {
  it.effect(`normalizes ${description}`, () =>
    Effect.gen(function* deviceAuthorizationFailureTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans[method] = rejectedPlan(deviceAuthorizationError(error, errorDescription));
      const adapter = yield* makeAdapter(fakes);

      const failure = yield* adapter
        .approveDeviceAuthorization(AUTHORIZATION, USER_CODE)
        .pipe(Effect.flip);

      expectSafeFailure(failure, expectedTag);
    }),
  );
}

it.effect("denies a code claimed by another authenticated principal", () =>
  Effect.gen(function* mismatchedPrincipalTest() {
    const fakes = makeBehaviorRuntimeFakes();
    fakes.plans.deviceVerify = resolvedPlan({
      status: "pending",
      user_code: USER_CODE,
    });
    const adapter = yield* makeAdapter(fakes);

    const failure = yield* adapter
      .approveDeviceAuthorization(AUTHORIZATION, USER_CODE)
      .pipe(Effect.flip);

    expectSafeFailure(failure, "DeviceAuthorizationAccessDenied");
    expect(fakes.callOrder).toStrictEqual(["deviceVerify"]);
  }),
);

it.effect("does not reapprove an authorization already completed", () =>
  Effect.gen(function* alreadyCompletedTest() {
    const fakes = makeBehaviorRuntimeFakes();
    fakes.plans.deviceVerify = resolvedPlan({
      status: "approved",
      user_code: USER_CODE,
    });
    const adapter = yield* makeAdapter(fakes);

    const failure = yield* adapter
      .approveDeviceAuthorization(AUTHORIZATION, USER_CODE)
      .pipe(Effect.flip);

    expectSafeFailure(failure, "DeviceAuthorizationAlreadyProcessed");
    expect(fakes.callOrder).toStrictEqual(["deviceVerify"]);
  }),
);
