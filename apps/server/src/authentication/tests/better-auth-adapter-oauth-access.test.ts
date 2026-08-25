import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  FIRST_CALL,
  ONE_CALL,
  expectSafeFailure,
  makeAdapter,
  makeBehaviorPrivateError,
  makeBehaviorRuntimeFakes,
  rejectedPlan,
} from "./better-auth-adapter-behavior.test-support.ts";
import type { BehaviorModuleLoader } from "./better-auth-adapter-behavior.test-support.ts";

const ACCESS_TOKEN = "header.payload.signature";
const AUTHORIZATION = `Bearer ${ACCESS_TOKEN}`;
const PRINCIPAL_ID = "authorizing-user-1";
const PUBLIC_URL = "https://public.nama.example/";
const REQUIRED_SCOPE = "nama:library";
const SECOND_PARAMETER = 1;

const isJwksFetch = (value: unknown): value is () => Promise<unknown> =>
  typeof value === "function";

const makeOAuthAdapter = (payload: Readonly<Record<string, unknown>>, verifyError?: Error) => {
  const fakes = makeBehaviorRuntimeFakes();
  const verificationCalls: unknown[][] = [];
  // oxlint-disable-next-line eslint/max-statements -- The verifier fixture captures token, options, local JWKS loading, and normalized failure behavior together.
  const verifier = async (...parameters: unknown[]) => {
    verificationCalls.push(parameters);
    if (verifyError !== undefined) {
      throw verifyError;
    }
    const [, options] = parameters;
    if (typeof options !== "object" || options === null) {
      throw new TypeError("verification options are required");
    }
    const jwksFetch: unknown = Reflect.get(options, "jwksFetch");
    if (!isJwksFetch(jwksFetch)) {
      throw new TypeError("local JWKS loader is required");
    }
    await jwksFetch();
    return payload;
  };
  const loadModule: BehaviorModuleLoader = (moduleId) => {
    if (moduleId === "better-auth/oauth2") {
      return { verifyJwsAccessToken: verifier };
    }
    return fakes.loadModule(moduleId);
  };
  return { adapter: makeAdapter(fakes, loadModule), fakes, verificationCalls };
};

it.effect("locally verifies an audience-bound Apple access JWT and returns its subject", () =>
  Effect.gen(function* validOAuthAccessTest() {
    const fixture = makeOAuthAdapter({
      aud: PUBLIC_URL,
      client_id: "nama-apple",
      exp: 1_800_000_000,
      iss: PUBLIC_URL,
      scope: "nama:library nama:playback nama:user-state offline_access",
      sub: PRINCIPAL_ID,
    });
    const adapter = yield* fixture.adapter;

    expect(yield* adapter.resolveOAuthAccess(AUTHORIZATION, REQUIRED_SCOPE)).toStrictEqual({
      id: PRINCIPAL_ID,
    });
    expect(fixture.verificationCalls).toHaveLength(ONE_CALL);
    const [firstVerification] = fixture.verificationCalls;
    expect(firstVerification?.[FIRST_CALL]).toBe(ACCESS_TOKEN);
    const options = firstVerification?.[SECOND_PARAMETER];
    expect(options).toMatchObject({
      verifyOptions: { audience: PUBLIC_URL, issuer: "https://public.nama.example" },
    });
    expect(fixture.fakes.captures.getJwks).toHaveLength(ONE_CALL);
  }),
);

const verifiedClaims = Object.freeze({
  aud: PUBLIC_URL,
  exp: 1_800_000_000,
  iss: PUBLIC_URL,
});
const rejectedClaims = [
  [
    "wrong client",
    { ...verifiedClaims, client_id: "other-client", scope: REQUIRED_SCOPE, sub: PRINCIPAL_ID },
    "InvalidBearer",
  ],
  [
    "missing subject",
    { ...verifiedClaims, client_id: "nama-apple", scope: REQUIRED_SCOPE },
    "InvalidBearer",
  ],
  [
    "missing required scope",
    {
      ...verifiedClaims,
      client_id: "nama-apple",
      scope: "nama:playback",
      sub: PRINCIPAL_ID,
    },
    "PermissionDenied",
  ],
  [
    "an audience array containing the resource",
    {
      ...verifiedClaims,
      aud: [PUBLIC_URL, "https://other.nama.example/"],
      client_id: "nama-apple",
      scope: REQUIRED_SCOPE,
      sub: PRINCIPAL_ID,
    },
    "InvalidBearer",
  ],
  [
    "missing expiry",
    {
      aud: PUBLIC_URL,
      client_id: "nama-apple",
      iss: PUBLIC_URL,
      scope: REQUIRED_SCOPE,
      sub: PRINCIPAL_ID,
    },
    "InvalidBearer",
  ],
] as const;

for (const [description, claims, expectedTag] of rejectedClaims) {
  it.effect(`rejects OAuth access with ${description}`, () =>
    Effect.gen(function* rejectedOAuthClaimsTest() {
      const fixture = makeOAuthAdapter(claims);
      const adapter = yield* fixture.adapter;
      const failure = yield* Effect.flip(adapter.resolveOAuthAccess(AUTHORIZATION, REQUIRED_SCOPE));
      expectSafeFailure(failure, expectedTag);
    }),
  );
}

it.effect("rejects a malformed OAuth bearer without attempting JWT verification", () =>
  Effect.gen(function* malformedOAuthBearerTest() {
    const fixture = makeOAuthAdapter({
      client_id: "nama-apple",
      scope: REQUIRED_SCOPE,
      sub: PRINCIPAL_ID,
    });
    const adapter = yield* fixture.adapter;
    const failure = yield* Effect.flip(
      adapter.resolveOAuthAccess("Bearer not-a-jwt", REQUIRED_SCOPE),
    );
    expectSafeFailure(failure, "InvalidBearer");
    expect(fixture.verificationCalls).toHaveLength(FIRST_CALL);
  }),
);

it.effect("normalizes JWT verification rejection without leaking verifier details", () =>
  Effect.gen(function* rejectedJwtTest() {
    const privateError = makeBehaviorPrivateError();
    const fixture = makeOAuthAdapter({}, privateError);
    const adapter = yield* fixture.adapter;
    const failure = yield* Effect.flip(adapter.resolveOAuthAccess(AUTHORIZATION, REQUIRED_SCOPE));
    expectSafeFailure(failure, "InvalidBearer");
  }),
);

it.effect("keeps a JWKS persistence failure distinct from an invalid token", () =>
  Effect.gen(function* failedJwksTest() {
    const privateError = makeBehaviorPrivateError();
    const fixture = makeOAuthAdapter({
      client_id: "nama-apple",
      scope: REQUIRED_SCOPE,
      sub: PRINCIPAL_ID,
    });
    fixture.fakes.plans.getJwks = rejectedPlan(privateError);
    const adapter = yield* fixture.adapter;
    const failure = yield* Effect.flip(adapter.resolveOAuthAccess(AUTHORIZATION, REQUIRED_SCOPE));
    expectSafeFailure(failure, "AuthenticationStoreUnavailable");
  }),
);
