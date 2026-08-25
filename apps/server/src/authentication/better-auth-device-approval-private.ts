import { Effect } from "effect";

import { APPLE_AUTHORIZATION_SCOPES, APPLE_PUBLIC_CLIENT_ID } from "../config/oauth.ts";
import {
  authenticationStoreUnavailable,
  invalidBearer,
  privateAuthenticationDefect,
} from "./better-auth-adapter-private.ts";
import type { InvalidBearer, StoreFailure } from "./better-auth-adapter-private.ts";
import { callRuntime, isObjectValue, readProperty } from "./better-auth-adapter-runtime.ts";

const SINGLE_RESOURCE_COUNT = 1;
const FIRST_RESOURCE_INDEX = 0;
const EXPECTED_APPLE_AUTHORIZATION_SCOPES = [...APPLE_AUTHORIZATION_SCOPES].toSorted();

const deviceAuthorizationCodeInvalid: DeviceAuthorizationCodeInvalid = Object.freeze({
  _tag: "DeviceAuthorizationCodeInvalid",
});
const deviceAuthorizationExpired: DeviceAuthorizationExpired = Object.freeze({
  _tag: "DeviceAuthorizationExpired",
});
const deviceAuthorizationAlreadyProcessed: DeviceAuthorizationAlreadyProcessed = Object.freeze({
  _tag: "DeviceAuthorizationAlreadyProcessed",
});
const deviceAuthorizationAccessDenied: DeviceAuthorizationAccessDenied = Object.freeze({
  _tag: "DeviceAuthorizationAccessDenied",
});

type DeviceAuthorizationCodeInvalid = Readonly<{
  readonly _tag: "DeviceAuthorizationCodeInvalid";
}>;
type DeviceAuthorizationExpired = Readonly<{
  readonly _tag: "DeviceAuthorizationExpired";
}>;
type DeviceAuthorizationAlreadyProcessed = Readonly<{
  readonly _tag: "DeviceAuthorizationAlreadyProcessed";
}>;
type DeviceAuthorizationAccessDenied = Readonly<{
  readonly _tag: "DeviceAuthorizationAccessDenied";
}>;
type DeviceAuthorizationApprovalFailure =
  | StoreFailure
  | InvalidBearer
  | DeviceAuthorizationCodeInvalid
  | DeviceAuthorizationExpired
  | DeviceAuthorizationAlreadyProcessed
  | DeviceAuthorizationAccessDenied;
type ApproveDeviceAuthorization = (
  authorization: string,
  userCode: string,
) => Effect.Effect<void, DeviceAuthorizationApprovalFailure>;

const readDeviceAuthorizationError = (
  rejection: unknown,
): Readonly<{ error: string; description: string }> | undefined => {
  if (!isObjectValue(rejection)) {
    return undefined;
  }
  const body = readProperty(rejection, "body");
  if (!isObjectValue(body)) {
    return undefined;
  }
  const error = readProperty(body, "error");
  const description = readProperty(body, "error_description");
  if (typeof error !== "string" || typeof description !== "string") {
    return undefined;
  }
  return { description, error };
};

const isAlreadyProcessed = (error: Readonly<{ error: string; description: string }>): boolean =>
  error.error === "device_code_already_processed" ||
  error.description === "Device code already processed";

const deviceAuthorizationFailureFromError = (error: string): DeviceAuthorizationApprovalFailure => {
  switch (error) {
    case "unauthorized": {
      return invalidBearer;
    }
    case "expired_token": {
      return deviceAuthorizationExpired;
    }
    case "access_denied": {
      return deviceAuthorizationAccessDenied;
    }
    case "invalid_request": {
      return deviceAuthorizationCodeInvalid;
    }
    default: {
      return authenticationStoreUnavailable;
    }
  }
};

const normalizeDeviceAuthorizationFailure = (
  rejection: unknown,
): DeviceAuthorizationApprovalFailure => {
  const error = readDeviceAuthorizationError(rejection);
  if (error === undefined) {
    return authenticationStoreUnavailable;
  }
  if (isAlreadyProcessed(error)) {
    return deviceAuthorizationAlreadyProcessed;
  }
  return deviceAuthorizationFailureFromError(error.error);
};

const isExactDeviceAuthorizationResource = (
  authorizationResource: unknown,
  resource: string,
): boolean =>
  authorizationResource === resource ||
  (Array.isArray(authorizationResource) &&
    authorizationResource.length === SINGLE_RESOURCE_COUNT &&
    authorizationResource[FIRST_RESOURCE_INDEX] === resource);

const hasExactDeviceAuthorizationScopes = (scope: unknown): boolean => {
  if (typeof scope !== "string") {
    return false;
  }
  const actualScopes = scope.split(/\s+/u).filter(Boolean).toSorted();
  return (
    actualScopes.length === EXPECTED_APPLE_AUTHORIZATION_SCOPES.length &&
    actualScopes.every(
      (candidate, index) => candidate === EXPECTED_APPLE_AUTHORIZATION_SCOPES[index],
    )
  );
};
const hasExpectedDeviceAuthorizationPolicy = (value: object, resource: string): boolean =>
  readProperty(value, "client_id") === APPLE_PUBLIC_CLIENT_ID &&
  isExactDeviceAuthorizationResource(readProperty(value, "resource"), resource) &&
  hasExactDeviceAuthorizationScopes(readProperty(value, "scope"));

const verifyDeviceAuthorizationContext = (
  value: unknown,
  resource: string,
): Effect.Effect<void, DeviceAuthorizationApprovalFailure> => {
  if (!isObjectValue(value)) {
    return Effect.fail(privateAuthenticationDefect);
  }
  const status = readProperty(value, "status");
  if (status === "approved" || status === "denied") {
    return Effect.fail(deviceAuthorizationAlreadyProcessed);
  }
  if (status !== "pending") {
    return Effect.fail(privateAuthenticationDefect);
  }
  if (!hasExpectedDeviceAuthorizationPolicy(value, resource)) {
    return Effect.fail(deviceAuthorizationAccessDenied);
  }
  return Effect.void;
};

const makeApproveDeviceAuthorization =
  (runtime: unknown, resource: string): ApproveDeviceAuthorization =>
  (authorization, userCode) =>
    Effect.suspend(() => {
      const headers = new Headers([["authorization", authorization]]);
      return callRuntime({
        defect: privateAuthenticationDefect,
        input: { headers, query: { user_code: userCode } },
        methodName: "deviceVerify",
        onRejection: normalizeDeviceAuthorizationFailure,
        runtime,
      }).pipe(
        Effect.flatMap((verification) => verifyDeviceAuthorizationContext(verification, resource)),
        Effect.andThen(
          callRuntime({
            defect: privateAuthenticationDefect,
            input: { body: { userCode }, headers },
            methodName: "deviceApprove",
            onRejection: normalizeDeviceAuthorizationFailure,
            runtime,
          }),
        ),
        Effect.flatMap((approval) => {
          if (!isObjectValue(approval) || readProperty(approval, "success") !== true) {
            return Effect.fail(privateAuthenticationDefect);
          }
          return Effect.void;
        }),
      );
    });

export { makeApproveDeviceAuthorization };
export type {
  ApproveDeviceAuthorization,
  DeviceAuthorizationAccessDenied,
  DeviceAuthorizationAlreadyProcessed,
  DeviceAuthorizationApprovalFailure,
  DeviceAuthorizationCodeInvalid,
  DeviceAuthorizationExpired,
};
