import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { makeAuthenticationService } from "../authentication-service.ts";
import type {
  Administrator,
  AuthenticationStoreUnavailable,
  BetterAuthAdapterService,
  InvalidBearer,
  PrivateAuthenticationDefect,
  ResolvedBearer,
} from "../better-auth-adapter.ts";
import { makeSignInLimiter } from "../sign-in-limiter.ts";

const FIXED_TIME_MILLISECONDS = 0;
const ADMINISTRATOR_ID = "administrator-1";
const SECOND_ADMINISTRATOR_ID = "administrator-2";
const DISPLAY_NAME = "Ada Administrator";
const SECOND_DISPLAY_NAME = "Grace Administrator";
const EMAIL = "ada.administrator@nama.example";
const SECOND_EMAIL = "grace.administrator@nama.example";
const AUTHORIZATION = "Bearer session-token.hmac-signature";
const SECOND_AUTHORIZATION = "Bearer second-session-token.second-signature";
const SESSION_EXPIRY = new Date("2026-09-01T12:00:00.000Z");
const SECOND_SESSION_EXPIRY = new Date("2026-10-01T12:00:00.000Z");
const PRIVATE_AUTHENTICATION_DETAIL = "private Better Auth runtime failure";

const administrator = Object.freeze({
  displayName: DISPLAY_NAME,
  email: EMAIL,
  id: ADMINISTRATOR_ID,
}) satisfies Administrator;
const secondAdministrator = Object.freeze({
  displayName: SECOND_DISPLAY_NAME,
  email: SECOND_EMAIL,
  id: SECOND_ADMINISTRATOR_ID,
}) satisfies Administrator;
const resolvedBearer = Object.freeze({
  administrator,
  sessionExpiresAt: SESSION_EXPIRY,
}) satisfies ResolvedBearer;
const secondResolvedBearer = Object.freeze({
  administrator: secondAdministrator,
  sessionExpiresAt: SECOND_SESSION_EXPIRY,
}) satisfies ResolvedBearer;
const invalidBearer = Object.freeze({ _tag: "InvalidBearer" }) satisfies InvalidBearer;
const authenticationStoreUnavailable = Object.freeze({
  _tag: "AuthenticationStoreUnavailable",
}) satisfies AuthenticationStoreUnavailable;
const privateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect",
}) satisfies PrivateAuthenticationDefect;
const sessionRevocationUnconfirmed = Object.freeze({
  _tag: "SessionRevocationUnconfirmed",
});

const resolveFailureCases = [
  ["an invalid bearer", invalidBearer],
  ["an unavailable authentication store", authenticationStoreUnavailable],
  ["a private authentication defect", privateAuthenticationDefect],
] as const;

type UnsafePrivateAuthenticationDefect = PrivateAuthenticationDefect &
  Readonly<{ readonly detail: string }>;

const makeAdapter = (overrides: Partial<BetterAuthAdapterService> = {}): BetterAuthAdapterService =>
  Object.freeze({
    createAdministrator: () => Effect.die("unexpected createAdministrator call"),
    resolveBearer: () => Effect.die("unexpected resolveBearer call"),
    signIn: () => Effect.die("unexpected signIn call"),
    signOut: () => Effect.die("unexpected signOut call"),
    ...overrides,
  });

const makeFixedTimeSignInLimiter = () => makeSignInLimiter({ now: () => FIXED_TIME_MILLISECONDS });

const makeUnsafePrivateFailure = (detail: string): UnsafePrivateAuthenticationDefect =>
  Object.freeze({
    _tag: "PrivateAuthenticationDefect",
    detail,
  });

const makeConcurrentResolutionFixture = () =>
  Effect.gen(function* concurrentResolutionFixture() {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const releaseResolutions = yield* Deferred.make<void>();
    const authentication = makeAuthenticationService({
      betterAuthAdapter: makeAdapter({
        resolveBearer: (authorization) => {
          if (authorization === AUTHORIZATION) {
            return Deferred.done(firstStarted, Exit.void).pipe(
              Effect.andThen(Deferred.await(releaseResolutions)),
              Effect.as(resolvedBearer),
            );
          }
          if (authorization === SECOND_AUTHORIZATION) {
            return Deferred.done(secondStarted, Exit.void).pipe(
              Effect.andThen(Deferred.await(releaseResolutions)),
              Effect.as(secondResolvedBearer),
            );
          }

          return Effect.die("unexpected authorization");
        },
      }),
      signInLimiter: makeFixedTimeSignInLimiter(),
    });

    return Object.freeze({
      authentication,
      firstStarted,
      releaseResolutions,
      secondStarted,
    });
  });

const expectSessionRevocationUnconfirmed = (failure: unknown): void => {
  expect(failure).toStrictEqual(sessionRevocationUnconfirmed);
  const representation = `${String(failure)}${JSON.stringify(failure)}`;
  expect(representation).not.toContain(AUTHORIZATION);
  expect(representation).not.toContain(PRIVATE_AUTHENTICATION_DETAIL);
};

it.effect("returns only the administrator from authoritative bearer resolution", () =>
  Effect.gen(function* resolveAdministratorTest() {
    const authorizations: string[] = [];
    const authentication = makeAuthenticationService({
      betterAuthAdapter: makeAdapter({
        resolveBearer: (authorization) =>
          Effect.sync(() => {
            authorizations.push(authorization);
          }).pipe(Effect.as(resolvedBearer)),
      }),
      signInLimiter: makeFixedTimeSignInLimiter(),
    });
    const resolved = yield* authentication.resolveAdministrator(AUTHORIZATION);
    expect(resolved).toStrictEqual(administrator);
    expect(authorizations).toStrictEqual([AUTHORIZATION]);
  }),
);

for (const [description, expectedFailure] of resolveFailureCases) {
  it.effect(`propagates ${description} from authoritative bearer resolution`, () =>
    Effect.gen(function* failedResolveAdministratorTest() {
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({ resolveBearer: () => Effect.fail(expectedFailure) }),
        signInLimiter: makeFixedTimeSignInLimiter(),
      });
      const failure = yield* authentication.resolveAdministrator(AUTHORIZATION).pipe(Effect.flip);
      expect(failure).toStrictEqual(expectedFailure);
    }),
  );
}

it.effect("keeps concurrent administrator resolutions local to their request results", () =>
  Effect.gen(function* concurrentResolutionTest() {
    const { authentication, firstStarted, releaseResolutions, secondStarted } =
      yield* makeConcurrentResolutionFixture();
    const firstResolution = yield* Effect.forkChild(
      authentication.resolveAdministrator(AUTHORIZATION),
    );
    const secondResolution = yield* Effect.forkChild(
      authentication.resolveAdministrator(SECOND_AUTHORIZATION),
    );
    yield* Deferred.await(firstStarted);
    yield* Deferred.await(secondStarted);
    yield* Deferred.done(releaseResolutions, Exit.void);

    expect(yield* Fiber.join(firstResolution)).toStrictEqual(administrator);
    expect(yield* Fiber.join(secondResolution)).toStrictEqual(secondAdministrator);
  }),
);

it.effect(
  "confirms SignOut after one mutation and one same-bearer resolution with an InvalidBearer confirmation",
  () =>
    Effect.gen(function* confirmedSignOutTest() {
      const events: string[] = [];
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({
          resolveBearer: (authorization) =>
            Effect.sync(() => {
              events.push(`resolve:${authorization}`);
            }).pipe(Effect.andThen(Effect.fail(invalidBearer))),
          signOut: (authorization) =>
            Effect.sync(() => {
              events.push(`signOut:${authorization}`);
            }),
        }),
        signInLimiter: makeFixedTimeSignInLimiter(),
      });

      expect(yield* authentication.signOut(AUTHORIZATION)).toBeUndefined();
      expect(events).toStrictEqual([`signOut:${AUTHORIZATION}`, `resolve:${AUTHORIZATION}`]);
    }),
);

it.effect("returns exact unconfirmed revocation when the presented session remains valid", () =>
  Effect.gen(function* validSessionAfterSignOutTest() {
    const events: string[] = [];
    const authentication = makeAuthenticationService({
      betterAuthAdapter: makeAdapter({
        resolveBearer: (authorization) =>
          Effect.sync(() => {
            events.push(`resolve:${authorization}`);
          }).pipe(Effect.as(resolvedBearer)),
        signOut: (authorization) =>
          Effect.sync(() => {
            events.push(`signOut:${authorization}`);
          }),
      }),
      signInLimiter: makeFixedTimeSignInLimiter(),
    });

    const failure = yield* authentication.signOut(AUTHORIZATION).pipe(Effect.flip);

    expectSessionRevocationUnconfirmed(failure);
    expect(events).toStrictEqual([`signOut:${AUTHORIZATION}`, `resolve:${AUTHORIZATION}`]);
  }),
);

it.effect(
  "returns unconfirmed revocation without confirmation or retry when the mutation rejects",
  () =>
    Effect.gen(function* rejectedSignOutTest() {
      const events: string[] = [];
      const privateFailure = makeUnsafePrivateFailure(PRIVATE_AUTHENTICATION_DETAIL);
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({
          resolveBearer: (authorization) =>
            Effect.sync(() => {
              events.push(`resolve:${authorization}`);
            }).pipe(Effect.as(resolvedBearer)),
          signOut: (authorization) =>
            Effect.sync(() => {
              events.push(`signOut:${authorization}`);
            }).pipe(Effect.andThen(Effect.fail(privateFailure))),
        }),
        signInLimiter: makeFixedTimeSignInLimiter(),
      });

      const failure = yield* authentication.signOut(AUTHORIZATION).pipe(Effect.flip);

      expectSessionRevocationUnconfirmed(failure);
      expect(events).toStrictEqual([`signOut:${AUTHORIZATION}`]);
    }),
);

it.effect(
  "returns unconfirmed revocation when authoritative confirmation cannot reach the store",
  () =>
    Effect.gen(function* unavailableConfirmationTest() {
      const events: string[] = [];
      const authentication = makeAuthenticationService({
        betterAuthAdapter: makeAdapter({
          resolveBearer: (authorization) =>
            Effect.sync(() => {
              events.push(`resolve:${authorization}`);
            }).pipe(Effect.andThen(Effect.fail(authenticationStoreUnavailable))),
          signOut: (authorization) =>
            Effect.sync(() => {
              events.push(`signOut:${authorization}`);
            }),
        }),
        signInLimiter: makeFixedTimeSignInLimiter(),
      });

      const failure = yield* authentication.signOut(AUTHORIZATION).pipe(Effect.flip);

      expectSessionRevocationUnconfirmed(failure);
      expect(events).toStrictEqual([`signOut:${AUTHORIZATION}`, `resolve:${AUTHORIZATION}`]);
    }),
);

it.effect("returns only unconfirmed revocation when confirmation is malformed or private", () =>
  Effect.gen(function* privateConfirmationTest() {
    const events: string[] = [];
    const privateFailure = makeUnsafePrivateFailure(PRIVATE_AUTHENTICATION_DETAIL);
    const authentication = makeAuthenticationService({
      betterAuthAdapter: makeAdapter({
        resolveBearer: (authorization) =>
          Effect.sync(() => {
            events.push(`resolve:${authorization}`);
          }).pipe(Effect.andThen(Effect.fail(privateFailure))),
        signOut: (authorization) =>
          Effect.sync(() => {
            events.push(`signOut:${authorization}`);
          }),
      }),
      signInLimiter: makeFixedTimeSignInLimiter(),
    });

    const failure = yield* authentication.signOut(AUTHORIZATION).pipe(Effect.flip);

    expectSessionRevocationUnconfirmed(failure);
    expect(events).toStrictEqual([`signOut:${AUTHORIZATION}`, `resolve:${AUTHORIZATION}`]);
  }),
);
