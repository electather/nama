import { Code } from "@connectrpc/connect";
import type { ConnectError } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { Effect } from "effect";

import {
  runGlobalLimiterPhase,
  runIdentityLimiterPhase,
  startConfiguredProcess,
  withDatabaseConnectionsDisabled,
  withTargetSessionDeleteFault,
} from "./authentication-failure-phases.test-support.ts";
import {
  ADMINISTRATOR,
  HTTP_READY,
  HTTP_SERVICE_UNAVAILABLE,
  createFailureState,
  expectSafeProcessOutputs,
  expireSessionForBearer,
  rawSessionTokenFromBearer,
} from "./authentication-failures.test-support.ts";
import type { FailureState } from "./authentication-failures.test-support.ts";
import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectApplicationError,
  expectApplicationFailure,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
  waitForBootstrapOutputOrExit,
} from "./authentication-process.test-support.ts";
import type { AuthenticationClients } from "./authentication-process.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import { startProcess, waitForStatus } from "./process.test-support.ts";

type FailurePhaseInput = Readonly<{ databaseUrl: string; state: FailureState }>;
type SessionPhaseInput = FailurePhaseInput & Readonly<{ clients: AuthenticationClients }>;
type SignInAuthorizationInput = Readonly<{
  clients: AuthenticationClients;
  phase: string;
  state: FailureState;
}>;
type UnconfirmedSignOutInput = Readonly<{
  authorization: string;
  clients: AuthenticationClients;
  publicErrors: ConnectError[];
}>;

const INTEGRATION_TIMEOUT_MILLISECONDS = 60_000;
const EMPTY_TOKEN_LENGTH = 0;

const runSetupPhase = (input: FailurePhaseInput) =>
  Effect.gen(function* setupPhase() {
    const runningProcess = yield* startProcess(input.databaseUrl);
    input.state.runningProcesses.push(runningProcess);
    yield* waitForBootstrapOutputOrExit(runningProcess, input.state.unsafeValues);
    yield* expectReady(runningProcess);
    const bootstrapToken = bootstrapTokenFrom(runningProcess);
    const clients = clientsFor(runningProcess.origin);
    const setupResponse = yield* expectRpcSuccess({
      invoke: () =>
        clients.setup.createAdministrator(
          {
            bootstrapToken,
            displayName: ADMINISTRATOR.displayName,
            email: ADMINISTRATOR.email,
            password: ADMINISTRATOR.password,
          },
          callOptions(),
        ),
      phase: "administrator setup",
    });
    expect(setupResponse.administrator).toMatchObject({
      displayName: ADMINISTRATOR.displayName,
      email: ADMINISTRATOR.email,
    });
    yield* stopCleanly(runningProcess);
    return bootstrapToken;
  });

const signInAuthorization = (input: SignInAuthorizationInput) =>
  Effect.gen(function* signInAuthorizationPhase() {
    const signIn = yield* expectRpcSuccess({
      invoke: () =>
        input.clients.authentication.signIn(
          { email: ADMINISTRATOR.email, password: ADMINISTRATOR.password },
          callOptions(),
        ),
      phase: input.phase,
    });
    const { credential } = signIn;
    const token = credential?.token;
    if (typeof token !== "string" || token.length === EMPTY_TOKEN_LENGTH) {
      throw new Error(`expected ${input.phase} signed bearer token`);
    }
    const authorization = `Bearer ${token}`;
    input.state.unsafeValues.push(
      token,
      authorization,
      rawSessionTokenFromBearer({ authorization }),
    );
    return authorization;
  });

const runExpiredBearerPhase = (input: SessionPhaseInput) =>
  Effect.gen(function* expiredBearerPhase() {
    const authorization = yield* signInAuthorization({
      clients: input.clients,
      phase: "expiring-session SignIn",
      state: input.state,
    });
    yield* expireSessionForBearer({ authorization, databaseUrl: input.databaseUrl });
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () => input.clients.authentication.getCurrentUser({}, callOptions(authorization)),
      publicErrors: input.state.publicErrors,
    });
  });

const expectUnconfirmedSignOut = (input: UnconfirmedSignOutInput) =>
  Effect.promise(async () => {
    try {
      await input.clients.authentication.signOut({}, callOptions(input.authorization));
    } catch (error) {
      const applicationError = expectApplicationError({
        error,
        expectedCode: Code.Unavailable,
        expectedReason: "SESSION_REVOCATION_UNCONFIRMED",
      });
      input.publicErrors.push(applicationError);
      return applicationError;
    }
    throw new Error("expected uncertain target-session SignOut failure");
  });

const runRevocationPhase = (input: SessionPhaseInput & Readonly<{ targetAuthorization: string }>) =>
  Effect.gen(function* revocationPhase() {
    yield* withTargetSessionDeleteFault({
      authorization: input.targetAuthorization,
      databaseUrl: input.databaseUrl,
      use: Effect.gen(function* targetSessionDeleteFailureTest() {
        const signOutFailure = yield* expectUnconfirmedSignOut({
          authorization: input.targetAuthorization,
          clients: input.clients,
          publicErrors: input.state.publicErrors,
        });
        expect(signOutFailure.findDetails(RetryInfoSchema)).toEqual([]);
        yield* expectRpcSuccess({
          invoke: () =>
            input.clients.authentication.getCurrentUser({}, callOptions(input.targetAuthorization)),
          phase: "unconfirmed target-session GetCurrentUser",
        });
      }),
    });
    yield* expectRpcSuccess({
      invoke: () =>
        input.clients.authentication.signOut({}, callOptions(input.targetAuthorization)),
      phase: "confirmed target-session SignOut",
    });
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () =>
        input.clients.authentication.getCurrentUser({}, callOptions(input.targetAuthorization)),
      publicErrors: input.state.publicErrors,
    });
  });

const runOutageRecoveryPhase = (
  input: SessionPhaseInput & Readonly<{ otherAuthorization: string; origin: string }>,
) =>
  Effect.gen(function* outageRecoveryPhase() {
    yield* withDatabaseConnectionsDisabled({
      databaseUrl: input.databaseUrl,
      use: Effect.gen(function* authenticationStoreOutageTest() {
        yield* waitForStatus(input.origin, "/health/ready", HTTP_SERVICE_UNAVAILABLE);
        yield* expectApplicationFailure({
          expectedCode: Code.Unavailable,
          expectedReason: "AUTHENTICATION_UNAVAILABLE",
          invoke: () =>
            input.clients.authentication.getCurrentUser({}, callOptions(input.otherAuthorization)),
          publicErrors: input.state.publicErrors,
        });
      }),
    });
    yield* waitForStatus(input.origin, "/health/ready", HTTP_READY);
    yield* expectRpcSuccess({
      invoke: () =>
        input.clients.authentication.getCurrentUser({}, callOptions(input.otherAuthorization)),
      phase: "recovered remaining-session GetCurrentUser",
    });
  });

const runSessionFailurePhase = (input: FailurePhaseInput) =>
  Effect.gen(function* sessionFailurePhase() {
    const { clients, runningProcess } = yield* startConfiguredProcess(input);
    yield* runExpiredBearerPhase({ clients, databaseUrl: input.databaseUrl, state: input.state });
    const targetAuthorization = yield* signInAuthorization({
      clients,
      phase: "target-session SignIn",
      state: input.state,
    });
    const otherAuthorization = yield* signInAuthorization({
      clients,
      phase: "remaining-session SignIn",
      state: input.state,
    });
    yield* runRevocationPhase({
      clients,
      databaseUrl: input.databaseUrl,
      state: input.state,
      targetAuthorization,
    });
    yield* expectRpcSuccess({
      invoke: () => clients.authentication.getCurrentUser({}, callOptions(otherAuthorization)),
      phase: "remaining-session GetCurrentUser",
    });
    yield* runOutageRecoveryPhase({
      clients,
      databaseUrl: input.databaseUrl,
      origin: runningProcess.origin,
      otherAuthorization,
      state: input.state,
    });
    yield* stopCleanly(runningProcess);
  });

it.live(
  "proves authentication limiter, expiry, revocation uncertainty, and store outage behavior",
  () =>
    withIsolatedDatabase((databaseUrl) =>
      Effect.gen(function* authenticationFailuresProcessTest() {
        const state = createFailureState({ databaseUrl });
        const bootstrapToken = yield* runSetupPhase({ databaseUrl, state });
        yield* runGlobalLimiterPhase({ databaseUrl, state });
        yield* runIdentityLimiterPhase({ databaseUrl, state });
        yield* runSessionFailurePhase({ databaseUrl, state });
        expectSafeProcessOutputs({ bootstrapToken, state });
      }).pipe(Effect.scoped),
    ),
  INTEGRATION_TIMEOUT_MILLISECONDS,
);
