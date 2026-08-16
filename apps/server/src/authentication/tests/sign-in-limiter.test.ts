import { expect, test } from "vitest";

import { makeSignInLimiter } from "../sign-in-limiter.ts";

const INITIAL_TIME_MILLISECONDS = 0;
const FIRST_ATTEMPT_INDEX = 0;
const ATTEMPT_INCREMENT = 1;
const ONE_MILLISECOND = 1;
const MINUTES_PER_WINDOW = 15;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const GLOBAL_SIGN_IN_ATTEMPT_LIMIT = 100;
const GLOBAL_WINDOW_MILLISECONDS = 10_000;
const IDENTITY_SIGN_IN_ATTEMPT_LIMIT = 5;
const IDENTITY_WINDOW_MILLISECONDS =
  MINUTES_PER_WINDOW * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const GLOBAL_CONCURRENT_CALLER_COUNT = GLOBAL_SIGN_IN_ATTEMPT_LIMIT + ATTEMPT_INCREMENT;
const IDENTITY_CONCURRENT_CALLER_COUNT = IDENTITY_SIGN_IN_ATTEMPT_LIMIT + ATTEMPT_INCREMENT;
const IDENTITY_EMAIL = "administrator@example.test";
const UPPERCASE_IDENTITY_EMAIL = "ADMINISTRATOR@EXAMPLE.TEST";
const EXPIRED_IDENTITY_EMAIL = "expired@example.test";
const CURRENT_IDENTITY_EMAIL = "current@example.test";
const ATTACKER_EMAIL_PREFIX = "attacker-";
const ATTACKER_EMAIL_DOMAIN = "@example.test";
const MIXED_CASE_IDENTITY_ATTEMPTS = [
  IDENTITY_EMAIL,
  UPPERCASE_IDENTITY_EMAIL,
  IDENTITY_EMAIL,
  UPPERCASE_IDENTITY_EMAIL,
  IDENTITY_EMAIL,
] as const;

interface TestClock {
  readonly now: () => number;
  readonly set: (milliseconds: number) => void;
}

interface SignInBudget {
  readonly consumeGlobal: () => number | undefined;
  readonly consumeIdentity: (email: string) => number | undefined;
}

const makeTestClock = (initialMilliseconds: number = INITIAL_TIME_MILLISECONDS): TestClock => {
  let milliseconds = initialMilliseconds;

  return {
    now: () => milliseconds,
    set: (nextMilliseconds: number) => {
      milliseconds = nextMilliseconds;
    },
  };
};

const consumeGlobalAttemptLimit = (limiter: SignInBudget): void => {
  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < GLOBAL_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    limiter.consumeGlobal();
  }
};

const consumeIdentityAttemptLimit = (limiter: SignInBudget, email: string): void => {
  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < IDENTITY_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    limiter.consumeIdentity(email);
  }
};

test("allows global SignIn attempts one through 100 and blocks attempt 101", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < GLOBAL_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(limiter.consumeGlobal()).toBeUndefined();
  }

  expect(limiter.consumeGlobal()).toBe(GLOBAL_WINDOW_MILLISECONDS);
});

test("allows identity SignIn attempts one through five and blocks attempt six", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < IDENTITY_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBeUndefined();
  }

  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBe(IDENTITY_WINDOW_MILLISECONDS);
});

test("reports the exact remaining global fixed-window delay through its reset boundary", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  consumeGlobalAttemptLimit(limiter);
  expect(limiter.consumeGlobal()).toBe(GLOBAL_WINDOW_MILLISECONDS);

  clock.set(GLOBAL_WINDOW_MILLISECONDS - ONE_MILLISECOND);
  expect(limiter.consumeGlobal()).toBe(ONE_MILLISECOND);

  clock.set(GLOBAL_WINDOW_MILLISECONDS);
  expect(limiter.consumeGlobal()).toBeUndefined();
});

test("reports the exact remaining identity fixed-window delay through its reset boundary", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  consumeIdentityAttemptLimit(limiter, IDENTITY_EMAIL);
  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBe(IDENTITY_WINDOW_MILLISECONDS);

  clock.set(IDENTITY_WINDOW_MILLISECONDS - ONE_MILLISECOND);
  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBe(ONE_MILLISECOND);

  clock.set(IDENTITY_WINDOW_MILLISECONDS);
  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBeUndefined();
});

test("keeps global and identity fixed windows independent", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  consumeGlobalAttemptLimit(limiter);
  consumeIdentityAttemptLimit(limiter, IDENTITY_EMAIL);
  clock.set(GLOBAL_WINDOW_MILLISECONDS);

  expect(limiter.consumeGlobal()).toBeUndefined();
  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBe(
    IDENTITY_WINDOW_MILLISECONDS - GLOBAL_WINDOW_MILLISECONDS,
  );
});

test("normalizes lower- and upper-case email to one identity window", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  for (const email of MIXED_CASE_IDENTITY_ATTEMPTS) {
    expect(limiter.consumeIdentity(email)).toBeUndefined();
  }

  expect(limiter.activeIdentityEntryCount).toBe(ATTEMPT_INCREMENT);
  expect(limiter.consumeIdentity(UPPERCASE_IDENTITY_EMAIL)).toBe(IDENTITY_WINDOW_MILLISECONDS);
});

test("clears a successful identity immediately so it receives five fresh attempts", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  consumeIdentityAttemptLimit(limiter, IDENTITY_EMAIL);
  limiter.clearIdentity(IDENTITY_EMAIL);

  expect(limiter.activeIdentityEntryCount).toBe(FIRST_ATTEMPT_INDEX);
  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < IDENTITY_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBeUndefined();
  }
  expect(limiter.consumeIdentity(IDENTITY_EMAIL)).toBe(IDENTITY_WINDOW_MILLISECONDS);
});

test("prunes expired identity entries before inserting a new identity", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  limiter.consumeIdentity(EXPIRED_IDENTITY_EMAIL);
  expect(limiter.activeIdentityEntryCount).toBe(ATTEMPT_INCREMENT);

  clock.set(IDENTITY_WINDOW_MILLISECONDS);
  limiter.consumeIdentity(CURRENT_IDENTITY_EMAIL);

  expect(limiter.activeIdentityEntryCount).toBe(ATTEMPT_INCREMENT);
});

test("bounds active identity entries when the SignIn pipeline consumes global budget first", () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < GLOBAL_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(limiter.consumeGlobal()).toBeUndefined();
    expect(
      limiter.consumeIdentity(`${ATTACKER_EMAIL_PREFIX}${attempt}${ATTACKER_EMAIL_DOMAIN}`),
    ).toBeUndefined();
  }

  expect(limiter.consumeGlobal()).toBe(GLOBAL_WINDOW_MILLISECONDS);
  expect(limiter.activeIdentityEntryCount).toBe(GLOBAL_SIGN_IN_ATTEMPT_LIMIT);
});

test("starts a new process-local limiter without global or identity state", () => {
  const clock = makeTestClock();
  const firstProcess = makeSignInLimiter({ now: clock.now });

  consumeGlobalAttemptLimit(firstProcess);
  consumeIdentityAttemptLimit(firstProcess, IDENTITY_EMAIL);
  clock.set(ONE_MILLISECOND);

  const restartedProcess = makeSignInLimiter({ now: clock.now });

  expect(restartedProcess.consumeGlobal()).toBeUndefined();
  expect(restartedProcess.consumeIdentity(IDENTITY_EMAIL)).toBeUndefined();
  expect(restartedProcess.activeIdentityEntryCount).toBe(ATTEMPT_INCREMENT);
});

test("caps concurrent global callers at 100 attempts", async () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  const decisions = await Promise.all(
    Array.from({ length: GLOBAL_CONCURRENT_CALLER_COUNT }, async () => {
      await Promise.resolve();
      return limiter.consumeGlobal();
    }),
  );

  expect(decisions.filter((decision) => decision === undefined)).toHaveLength(
    GLOBAL_SIGN_IN_ATTEMPT_LIMIT,
  );
  expect(decisions.filter((decision) => decision !== undefined)).toEqual([
    GLOBAL_WINDOW_MILLISECONDS,
  ]);
});

test("caps concurrent identity callers at five attempts", async () => {
  const clock = makeTestClock();
  const limiter = makeSignInLimiter({ now: clock.now });

  const decisions = await Promise.all(
    Array.from({ length: IDENTITY_CONCURRENT_CALLER_COUNT }, async () => {
      await Promise.resolve();
      return limiter.consumeIdentity(IDENTITY_EMAIL);
    }),
  );

  expect(decisions.filter((decision) => decision === undefined)).toHaveLength(
    IDENTITY_SIGN_IN_ATTEMPT_LIMIT,
  );
  expect(decisions.filter((decision) => decision !== undefined)).toEqual([
    IDENTITY_WINDOW_MILLISECONDS,
  ]);
});
