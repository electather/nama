import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import type { RuntimeResult } from "./better-auth-adapter-behavior.test-support.ts";
import {
  BETTER_AUTH_ABSENT,
  DISPLAY_NAME,
  EMAIL,
  EMPTY_STRING,
  FIRST_CALL,
  INVALID_NUMBER,
  PASSWORD,
  ONE_CALL,
  PRIVATE_RESPONSE_TOKEN,
  expectedAdministrator,
  expectCreateAdministratorCall,
  expectPrivateValuesAbsent,
  expectSafeFailure,
  makeAdapter,
  makeBehaviorRuntimeFakes,
  makeRuntimeUser,
  resolvedPlan,
} from "./better-auth-adapter-behavior.test-support.ts";

interface MalformedCreateAdministratorCase {
  readonly description: string;
  readonly result: RuntimeResult;
}

const malformedCreateAdministratorCases: readonly MalformedCreateAdministratorCase[] = [
  { description: "a null result", result: BETTER_AUTH_ABSENT },
  {
    description: "a non-null sign-up token",
    result: { token: PRIVATE_RESPONSE_TOKEN, user: makeRuntimeUser() },
  },
  {
    description: "a null user",
    result: { token: BETTER_AUTH_ABSENT, user: BETTER_AUTH_ABSENT },
  },
  {
    description: "an empty user id",
    result: { token: BETTER_AUTH_ABSENT, user: { ...makeRuntimeUser(), id: EMPTY_STRING } },
  },
  {
    description: "a non-string user name",
    result: {
      token: BETTER_AUTH_ABSENT,
      user: { ...makeRuntimeUser(), name: INVALID_NUMBER },
    },
  },
  {
    description: "a non-string user email",
    result: { token: BETTER_AUTH_ABSENT, user: { ...makeRuntimeUser(), email: false } },
  },
];

it.effect(
  "creates an administrator with the exact no-session Better Auth call and strips private fields",
  () =>
    Effect.gen(function* createAdministratorTest() {
      const fakes = makeBehaviorRuntimeFakes();
      const adapter = yield* makeAdapter(fakes);
      const administrator = yield* adapter.createAdministrator({
        email: EMAIL,
        name: DISPLAY_NAME,
        password: PASSWORD,
      });

      expect(administrator).toStrictEqual(expectedAdministrator);
      expectPrivateValuesAbsent(administrator);
      expect(fakes.captures.signUpEmail).toHaveLength(ONE_CALL);
      expectCreateAdministratorCall(fakes.captures.signUpEmail[FIRST_CALL]);
      expect(fakes.captures.getSession).toEqual([]);
      expect(fakes.captures.signInEmail).toEqual([]);
      expect(fakes.captures.signOut).toEqual([]);
    }),
);

for (const { description, result } of malformedCreateAdministratorCases) {
  it.effect(`rejects ${description} from signUpEmail as a private authentication defect`, () =>
    Effect.gen(function* malformedCreateAdministratorTest() {
      const fakes = makeBehaviorRuntimeFakes();
      fakes.plans.signUpEmail = resolvedPlan(result);
      const adapter = yield* makeAdapter(fakes);
      const failure = yield* adapter
        .createAdministrator({ email: EMAIL, name: DISPLAY_NAME, password: PASSWORD })
        .pipe(Effect.flip);

      expectSafeFailure(failure, "PrivateAuthenticationDefect");
      expect(fakes.captures.signUpEmail).toHaveLength(ONE_CALL);
      expectCreateAdministratorCall(fakes.captures.signUpEmail[FIRST_CALL]);
      expect(fakes.captures.getSession).toEqual([]);
    }),
  );
}
