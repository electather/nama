import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeAuthenticationService } from "../authentication-service.ts";
import type {
  AuthenticationStoreUnavailable,
  BetterAuthAdapterService,
  InvalidCredentials,
  PrivateAuthenticationDefect,
  SignedInAdministrator,
} from "../better-auth-adapter.ts";
import { makeSignInLimiter } from "../sign-in-limiter.ts";

const INITIAL_TIME_MILLISECONDS = 0;
const FIRST_ATTEMPT_INDEX = 0;
const ATTEMPT_INCREMENT = 1;
const MINUTES_PER_WINDOW = 15;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const GLOBAL_SIGN_IN_ATTEMPT_LIMIT = 100;
const GLOBAL_WINDOW_MILLISECONDS = 10_000;
const GLOBAL_WINDOW_ELAPSED_MILLISECONDS = 2345;
const IDENTITY_SIGN_IN_ATTEMPT_LIMIT = 5;
const IDENTITY_WINDOW_MILLISECONDS =
  MINUTES_PER_WINDOW * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const IDENTITY_WINDOW_ELAPSED_MILLISECONDS = 1234;
const IDENTITY_RETRY_DELAY_MILLISECONDS =
  IDENTITY_WINDOW_MILLISECONDS - IDENTITY_WINDOW_ELAPSED_MILLISECONDS;
const ADMINISTRATOR_ID = "administrator-1";
const DISPLAY_NAME = "Ada Administrator";
const EMAIL = "ada.administrator@nama.example";
const UPPERCASE_EMAIL = "ADA.ADMINISTRATOR@NAMA.EXAMPLE";
const PASSWORD = "correct-horse-battery-staple";
const SIGNED_BEARER = "session-token.hmac-signature";
const SESSION_EXPIRY = new Date("2026-09-01T12:00:00.000Z");

const signedInAdministrator = Object.freeze({
  administrator: Object.freeze({
    displayName: DISPLAY_NAME,
    email: EMAIL,
    id: ADMINISTRATOR_ID,
  }),
  bearer: SIGNED_BEARER,
  sessionExpiresAt: SESSION_EXPIRY,
}) satisfies SignedInAdministrator;
const invalidCredentials = Object.freeze({
  _tag: "InvalidCredentials",
}) satisfies InvalidCredentials;
const authenticationStoreUnavailable = Object.freeze({
  _tag: "AuthenticationStoreUnavailable",
}) satisfies AuthenticationStoreUnavailable;
const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect",
}) satisfies PrivateAuthenticationDefect;

const signInFailureCases = [
  ["unknown email", invalidCredentials],
  ["wrong password", invalidCredentials],
  ["authentication-store failure", authenticationStoreUnavailable],
  ["private authentication defect", privateAuthenticationDefect],
] as const;

interface TestClock {
  readonly advance: (milliseconds: number) => void;
  readonly now: () => number;
}

interface SignInBudget {
  readonly consumeGlobal: () => number | undefined;
  readonly consumeIdentity: (email: string) => number | undefined;
}

const makeTestClock = (initialMilliseconds: number = INITIAL_TIME_MILLISECONDS): TestClock => {
  let currentMilliseconds = initialMilliseconds;

  return Object.freeze({
    advance: (milliseconds: number) => {
      currentMilliseconds += milliseconds;
    },
    now: () => currentMilliseconds,
  });
};

const makeAdapter = (overrides: Partial<BetterAuthAdapterService> = {}): BetterAuthAdapterService =>
  Object.freeze({
    approveDeviceAuthorization: () => Effect.die("unexpected approveDeviceAuthorization call"),
    createAdministrator: () => Effect.die("unexpected createAdministrator call"),
    oauthRequestListener: () => {},
    resolveBearer: () => Effect.die("unexpected resolveBearer call"),
    resolveOAuthAccess: () => Effect.die("unexpected resolveOAuthAccess call"),
    revokeAppleClientRefreshTokens: Effect.die("unexpected revokeAppleClientRefreshTokens call"),
    signIn: () => Effect.die("unexpected signIn call"),
    signOut: () => Effect.die("unexpected signOut call"),
    ...overrides,
  });

const makeAuthenticationFixture = () => {
  const clock = makeTestClock();
  const signInLimiter = makeSignInLimiter({ now: clock.now });
  const authentication = makeAuthenticationService({
    betterAuthAdapter: makeAdapter(),
    signInLimiter,
  });

  return Object.freeze({ authentication, clock, signInLimiter });
};

const expectRemainingGlobalAttemptsAreAvailable = (signInLimiter: SignInBudget): void => {
  for (
    let attempt = ATTEMPT_INCREMENT;
    attempt < GLOBAL_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(signInLimiter.consumeGlobal()).toBeUndefined();
  }
};

const expectIdentityAttemptsAreAvailable = (signInLimiter: SignInBudget, email: string): void => {
  for (
    let attempt = FIRST_ATTEMPT_INDEX;
    attempt < IDENTITY_SIGN_IN_ATTEMPT_LIMIT;
    attempt += ATTEMPT_INCREMENT
  ) {
    expect(signInLimiter.consumeIdentity(email)).toBeUndefined();
  }
};

it.effect(
  "passes through raw global and validated-identity limiter delays without creating transport errors",
  () =>
    Effect.gen(function* limiterIntegrationTest() {
      const { authentication, clock, signInLimiter } = makeAuthenticationFixture();

      expect(yield* authentication.consumeGlobalSignInBudget).toBeUndefined();
      expectRemainingGlobalAttemptsAreAvailable(signInLimiter);
      clock.advance(GLOBAL_WINDOW_ELAPSED_MILLISECONDS);
      expect(yield* authentication.consumeGlobalSignInBudget).toBe(
        GLOBAL_WINDOW_MILLISECONDS - GLOBAL_WINDOW_ELAPSED_MILLISECONDS,
      );

      expectIdentityAttemptsAreAvailable(signInLimiter, EMAIL);
      clock.advance(IDENTITY_WINDOW_ELAPSED_MILLISECONDS);
      expect(yield* authentication.consumeIdentitySignInBudget(UPPERCASE_EMAIL)).toBe(
        IDENTITY_RETRY_DELAY_MILLISECONDS,
      );
    }),
);

it.effect(
  "returns only the adapter's Nama sign-in result and immediately clears the normalized identity",
  () =>
    Effect.gen(function* successfulSignInTest() {
      const clock = makeTestClock();
      const signInLimiter = makeSignInLimiter({ now: clock.now });
      const signInCalls: unknown[] = [];
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({
          signIn: (input) =>
            Effect.sync(() => {
              signInCalls.push(input);
            }).pipe(Effect.as(signedInAdministrator)),
        }),
        signInLimiter,
      });

      expectIdentityAttemptsAreAvailable(signInLimiter, EMAIL);

      const signedIn = yield* authentication.signIn({ email: UPPERCASE_EMAIL, password: PASSWORD });

      expect(signedIn).toStrictEqual(signedInAdministrator);
      expect(signInCalls).toStrictEqual([{ email: UPPERCASE_EMAIL, password: PASSWORD }]);
      expectIdentityAttemptsAreAvailable(signInLimiter, EMAIL);
      expect(yield* authentication.consumeIdentitySignInBudget(EMAIL)).toBe(
        IDENTITY_WINDOW_MILLISECONDS,
      );
    }),
);

for (const [description, expectedFailure] of signInFailureCases) {
  it.effect(`propagates ${description} without clearing its identity entry`, () =>
    Effect.gen(function* failedSignInTest() {
      const clock = makeTestClock();
      const signInLimiter = makeSignInLimiter({ now: clock.now });
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({ signIn: () => Effect.fail(expectedFailure) }),
        signInLimiter,
      });

      expectIdentityAttemptsAreAvailable(signInLimiter, EMAIL);

      const failure = yield* authentication
        .signIn({ email: UPPERCASE_EMAIL, password: PASSWORD })
        .pipe(Effect.flip);

      expect(failure).toStrictEqual(expectedFailure);
      expect(yield* authentication.consumeIdentitySignInBudget(EMAIL)).toBe(
        IDENTITY_WINDOW_MILLISECONDS,
      );
    }),
  );
}
