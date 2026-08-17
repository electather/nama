import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { RuntimeResult } from "./better-auth-adapter-behavior.test-support.ts";
import {
  BETTER_AUTH_ABSENT,
  AUTHORIZATION,
  EMPTY_STRING,
  FIRST_CALL,
  ONE_CALL,
  INVALID_DATE_TEXT,
  INVALID_NUMBER,
  expectedResolvedBearer,
  expectPrivateValuesAbsent,
  expectResolveBearerCall,
  expectSafeFailure,
  makeAdapter,
  makeBehaviorPrivateError,
  makeBehaviorRuntimeFakes,
  makeRuntimeSession,
  makeRuntimeUser,
  rejectedPlan,
  resolvedPlan,
} from "./better-auth-adapter-behavior.test-support.ts";

interface MalformedSessionCase {
  readonly description: string;
  readonly result: RuntimeResult;
}

const malformedSessionCases: readonly MalformedSessionCase[] = [
  { description: "an undefined session result", result: undefined },
  {
    description: "a null nested session",
    result: { session: BETTER_AUTH_ABSENT, user: makeRuntimeUser() },
  },
  {
    description: "a null nested user",
    result: { session: makeRuntimeSession(), user: BETTER_AUTH_ABSENT },
  },
  {
    description: "an empty administrator id",
    result: { session: makeRuntimeSession(), user: { ...makeRuntimeUser(), id: EMPTY_STRING } },
  },
  {
    description: "a non-string administrator display name",
    result: { session: makeRuntimeSession(), user: { ...makeRuntimeUser(), name: false } },
  },
  {
    description: "a non-string administrator email",
    result: {
      session: makeRuntimeSession(),
      user: { ...makeRuntimeUser(), email: INVALID_NUMBER },
    },
  },
  {
    description: "an invalid session expiry",
    result: {
      session: { ...makeRuntimeSession(), expiresAt: new Date(INVALID_DATE_TEXT) },
      user: makeRuntimeUser(),
    },
  },
];

it.effect(
  "resolves an exact authorization value with an authoritative no-cache, no-refresh session lookup",
  () =>
    Effect.gen(function* resolveBearerTest() {
      const fakes = makeBehaviorRuntimeFakes();
      const adapter = yield* makeAdapter(fakes);
      const resolved = yield* adapter.resolveBearer(AUTHORIZATION);

      expect(resolved).toStrictEqual(expectedResolvedBearer);
      expectPrivateValuesAbsent(resolved);
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
      expect(fakes.captures.signInEmail).toEqual([]);
      expect(fakes.captures.signOut).toEqual([]);
      expect(fakes.captures.signUpEmail).toEqual([]);
    }),
);

it.effect(
  "maps an authoritative null session to an invalid bearer without exposing private data",
  () =>
    Effect.gen(function* invalidBearerTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.getSession = resolvedPlan(BETTER_AUTH_ABSENT);
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter.resolveBearer(AUTHORIZATION).pipe(Effect.flip);

      expectSafeFailure(failure, "InvalidBearer");
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
    }),
);

for (const { description, result } of malformedSessionCases) {
  it.effect(`rejects ${description} from getSession as a private authentication defect`, () =>
    Effect.gen(function* malformedSessionTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.getSession = resolvedPlan(result);
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter.resolveBearer(AUTHORIZATION).pipe(Effect.flip);

      expectSafeFailure(failure, "PrivateAuthenticationDefect");
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
    }),
  );
}

it.effect(
  "maps a rejected authoritative session lookup to an unavailable authentication store",
  () =>
    Effect.gen(function* resolveBearerStoreFailureTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.getSession = rejectedPlan(makeBehaviorPrivateError());
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter.resolveBearer(AUTHORIZATION).pipe(Effect.flip);

      expectSafeFailure(failure, "AuthenticationStoreUnavailable");
      expect(fakes.captures.getSession).toHaveLength(ONE_CALL);
      expectResolveBearerCall(fakes.captures.getSession[FIRST_CALL]);
    }),
);
