import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { RuntimeResult } from "./better-auth-adapter-behavior.test-support.ts";
import {
  AUTHORIZATION,
  BETTER_AUTH_ABSENT,
  EMAIL,
  EMPTY_STRING,
  FIRST_CALL,
  ONE_CALL,
  PASSWORD,
  PRIVATE_COOKIE,
  SET_AUTH_TOKEN_HEADER,
  SIGNED_BEARER,
  expectedSignIn,
  expectPrivateValuesAbsent,
  expectResolveBearerCall,
  expectSafeFailure,
  expectSignInCall,
  expectSignOutCall,
  makeAdapter,
  makeBehaviorPrivateError,
  makeBehaviorRuntimeFakes,
  makeInvalidCredentialsError,
  makeSignInResponse,
  rejectedPlan,
  resolvedPlan,
} from "./better-auth-adapter-behavior.test-support.ts";

interface MalformedSignInCase {
  readonly description: string;
  readonly result: RuntimeResult;
}

const invalidCredentialDescriptions = ["unknown email", "wrong password"];
const malformedSignInCases: readonly MalformedSignInCase[] = [
  {
    description: "a missing set-auth-token header",
    result: {
      headers: new Headers([["set-cookie", PRIVATE_COOKIE]]),
      response: makeSignInResponse()["response"],
    },
  },
  {
    description: "an empty set-auth-token header",
    result: {
      headers: new Headers([[SET_AUTH_TOKEN_HEADER, EMPTY_STRING]]),
      response: makeSignInResponse()["response"],
    },
  },
  {
    description: "an unsigned set-auth-token header",
    result: {
      headers: new Headers([[SET_AUTH_TOKEN_HEADER, "unsigned-session-token"]]),
      response: makeSignInResponse()["response"],
    },
  },
  {
    description: "a non-Headers header result",
    result: {
      headers: { [SET_AUTH_TOKEN_HEADER]: SIGNED_BEARER },
      response: makeSignInResponse()["response"],
    },
  },
  {
    description: "a null response body",
    result: { headers: makeSignInResponse()["headers"], response: BETTER_AUTH_ABSENT },
  },
  {
    description: "an array response body",
    result: { headers: makeSignInResponse()["headers"], response: [] },
  },
];
const expectSignInResult = (result: unknown): void => {
  expect(result).toStrictEqual(expectedSignIn);
  expectPrivateValuesAbsent(result);
};

it.effect(
  "signs in through Better Auth's pinned signed-header bearer and resolves it exactly once before returning Nama values",
  () =>
    Effect.gen(function* signInTest() {
      const fakes = makeBehaviorRuntimeFakes();
      const adapter = yield* makeAdapter(fakes);
      const signedIn = yield* adapter.signIn({ email: EMAIL, password: PASSWORD });

      expectSignInResult(signedIn);
      expect(fakes.captures.signInEmail).toHaveLength(ONE_CALL);
      expectSignInCall(fakes.captures.signInEmail[FIRST_CALL]);
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
      expect(fakes.captures.signOut).toEqual([]);
      expect(fakes.captures.signUpEmail).toEqual([]);
    }),
);

for (const description of invalidCredentialDescriptions) {
  it.effect(
    `maps the pinned invalid-email-or-password response for ${description} without leaking it`,
    () =>
      Effect.gen(function* invalidCredentialsTest() {
        const fakes = makeBehaviorRuntimeFakes();
        fakes.plans.signInEmail = rejectedPlan(makeInvalidCredentialsError());
        const adapter = yield* makeAdapter(fakes);
        const failure = yield* adapter
          .signIn({ email: EMAIL, password: PASSWORD })
          .pipe(Effect.flip);

        expectSafeFailure(failure, "InvalidCredentials");
        expect(fakes.captures.signInEmail).toHaveLength(ONE_CALL);
        expectSignInCall(fakes.captures.signInEmail[FIRST_CALL]);
        expect(fakes.captures.getSession).toEqual([]);
      }),
  );
}

it.effect("maps a rejected Better Auth sign-in call to an unavailable authentication store", () =>
  Effect.gen(function* signInStoreFailureTest() {
    const fakes = makeBehaviorRuntimeFakes();
    fakes.plans.signInEmail = rejectedPlan(makeBehaviorPrivateError());
    const adapter = yield* makeAdapter(fakes);
    const failure = yield* adapter.signIn({ email: EMAIL, password: PASSWORD }).pipe(Effect.flip);

    expectSafeFailure(failure, "AuthenticationStoreUnavailable");
    expect(fakes.captures.signInEmail).toHaveLength(ONE_CALL);
    expectSignInCall(fakes.captures.signInEmail[FIRST_CALL]);
    expect(fakes.captures.getSession).toEqual([]);
  }),
);

it.effect(
  "maps a rejected authoritative sign-in resolution to an unavailable authentication store",
  () =>
    Effect.gen(function* signInResolutionStoreFailureTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.getSession = rejectedPlan(makeBehaviorPrivateError());
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter.signIn({ email: EMAIL, password: PASSWORD }).pipe(Effect.flip);

      expectSafeFailure(failure, "AuthenticationStoreUnavailable");
      expect(fakes.captures.signInEmail).toHaveLength(ONE_CALL);
      expectSignInCall(fakes.captures.signInEmail[FIRST_CALL]);
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
    }),
);

for (const { description, result } of malformedSignInCases) {
  it.effect(
    `rejects ${description} as a private authentication defect before bearer resolution`,
    () =>
      Effect.gen(function* malformedSignInTest() {
        const fakes = makeBehaviorRuntimeFakes();
        fakes.plans.signInEmail = resolvedPlan(result);
        const adapter = yield* makeAdapter(fakes);
        const failure = yield* adapter
          .signIn({ email: EMAIL, password: PASSWORD })
          .pipe(Effect.flip);

        expectSafeFailure(failure, "PrivateAuthenticationDefect");
        expect(fakes.captures.signInEmail).toHaveLength(ONE_CALL);
        expectSignInCall(fakes.captures.signInEmail[FIRST_CALL]);
        expect(fakes.captures.getSession).toEqual([]);
      }),
  );
}

it.effect(
  "signs out with only the presented authorization header and discards Better Auth's result",
  () =>
    Effect.gen(function* signOutTest() {
      const fakes = makeBehaviorRuntimeFakes();
      const adapter = yield* makeAdapter(fakes);
      const result = yield* adapter.signOut(AUTHORIZATION);

      expect(result).toBeUndefined();
      expectPrivateValuesAbsent(result);
      expect(fakes.captures.signOut).toHaveLength(ONE_CALL);
      expectSignOutCall(fakes.captures.signOut[FIRST_CALL]);
      expect(fakes.captures.getSession).toEqual([]);
      expect(fakes.captures.signInEmail).toEqual([]);
      expect(fakes.captures.signUpEmail).toEqual([]);
    }),
);

it.effect(
  "maps a rejected Better Auth sign-out mutation to an unavailable authentication store",
  () =>
    Effect.gen(function* signOutStoreFailureTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.signOut = rejectedPlan(makeBehaviorPrivateError());
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter.signOut(AUTHORIZATION).pipe(Effect.flip);

      expectSafeFailure(failure, "AuthenticationStoreUnavailable");
      expect(fakes.captures.signOut).toHaveLength(ONE_CALL);
      expectSignOutCall(fakes.captures.signOut[FIRST_CALL]);
      expect(fakes.captures.getSession).toEqual([]);
    }),
);
