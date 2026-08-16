import { Context, Effect, Layer } from "effect";

import { BetterAuthAdapter } from "./better-auth-adapter.ts";
import type {
  Administrator,
  AuthenticationFailure,
  BetterAuthAdapterService,
  InvalidCredentials,
  SignInInput,
} from "./better-auth-adapter.ts";
import { makeSignInLimiter } from "./sign-in-limiter.ts";
import type { SignInLimiter } from "./sign-in-limiter.ts";

const contextService = Context.Service;

type ResolveAdministratorFailure = Exclude<AuthenticationFailure, InvalidCredentials>;
type SessionRevocationUnconfirmed = Readonly<{
  readonly _tag: "SessionRevocationUnconfirmed";
}>;

interface AuthenticationService {
  readonly consumeGlobalSignInBudget: Effect.Effect<number | undefined>;
  readonly consumeIdentitySignInBudget: (
    validatedEmail: string,
  ) => Effect.Effect<number | undefined>;
  readonly resolveAdministrator: (
    authorization: string,
  ) => Effect.Effect<Administrator, ResolveAdministratorFailure>;
  readonly signIn: BetterAuthAdapterService["signIn"];
  readonly signOut: (authorization: string) => Effect.Effect<void, SessionRevocationUnconfirmed>;
}

interface AuthenticationServiceDependencies {
  readonly betterAuthAdapter: BetterAuthAdapterService;
  readonly signInLimiter: SignInLimiter;
}

const sessionRevocationUnconfirmed: SessionRevocationUnconfirmed = Object.freeze({
  _tag: "SessionRevocationUnconfirmed",
});

const makeAuthenticationService = ({
  betterAuthAdapter,
  signInLimiter,
}: AuthenticationServiceDependencies): AuthenticationService => {
  const consumeGlobalSignInBudget = Effect.sync(() => signInLimiter.consumeGlobal());
  const consumeIdentitySignInBudget = (validatedEmail: string) =>
    Effect.sync(() => signInLimiter.consumeIdentity(validatedEmail));
  const signIn = (input: SignInInput) =>
    betterAuthAdapter.signIn(input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          signInLimiter.clearIdentity(input.email);
        }),
      ),
    );
  const resolveAdministrator = (authorization: string) =>
    betterAuthAdapter
      .resolveBearer(authorization)
      .pipe(Effect.map((resolvedBearer) => resolvedBearer.administrator));
  const confirmSignOut = (authorization: string) =>
    betterAuthAdapter.resolveBearer(authorization).pipe(
      Effect.flatMap((resolvedBearer) => {
        if (resolvedBearer === null) {
          return Effect.void;
        }

        return Effect.fail(sessionRevocationUnconfirmed);
      }),
      Effect.catchTag("InvalidBearer", () => Effect.void),
      Effect.matchEffect({
        onFailure: () => Effect.fail(sessionRevocationUnconfirmed),
        onSuccess: () => Effect.void,
      }),
    );
  const signOut = (authorization: string) =>
    betterAuthAdapter.signOut(authorization).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.fail(sessionRevocationUnconfirmed),
        onSuccess: () => confirmSignOut(authorization),
      }),
    );

  return Object.freeze({
    consumeGlobalSignInBudget,
    consumeIdentitySignInBudget,
    resolveAdministrator,
    signIn,
    signOut,
  });
};

class Authentication extends contextService<Authentication, AuthenticationService>()(
  "@nama/server/Authentication",
) {
  static readonly layer = Layer.effect(
    Authentication,
    Effect.gen(function* makeAuthenticationServiceLayer() {
      const betterAuthAdapter = yield* BetterAuthAdapter;
      return Authentication.of(
        makeAuthenticationService({
          betterAuthAdapter,
          signInLimiter: makeSignInLimiter({ now: Date.now }),
        }),
      );
    }),
  );
}

export { Authentication, makeAuthenticationService };
export type {
  AuthenticationService,
  AuthenticationServiceDependencies,
  ResolveAdministratorFailure,
  SessionRevocationUnconfirmed,
};
