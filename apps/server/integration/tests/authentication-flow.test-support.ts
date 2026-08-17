import { Code } from "@connectrpc/connect";
import type { ConnectError } from "@connectrpc/connect";
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import type { ExpectedAdministrator } from "./authentication-details.test-support.ts";
import {
  administratorFromSetup,
  credentialFailureShape,
  expectAdministrator,
} from "./authentication-details.test-support.ts";
import { expectAuthenticationFailure } from "./authentication-failures.test-support.ts";
import type {
  AuthenticationClients,
  ExpectedFieldViolation,
} from "./authentication-process.test-support.ts";
import {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectApplicationError,
  expectApplicationFailure,
  expectReady,
  expectRpcSuccess,
  waitForBootstrapOutputOrExit,
} from "./authentication-process.test-support.ts";
import { withPool } from "./database.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";
import { startProcess } from "./process.test-support.ts";

interface AuthenticationScenario {
  readonly databaseUrl: string;
  readonly displayName: string;
  readonly email: string;
  readonly invalidSetupFieldViolations: readonly ExpectedFieldViolation[];
  readonly password: string;
  readonly signedBearerPattern: RegExp;
  readonly startupSensitiveValues: readonly string[];
  readonly unknownEmail: string;
  readonly wrongBootstrapToken: string;
  readonly wrongPassword: string;
}
interface AuthenticationFlow extends AuthenticationScenario {
  readonly bootstrapToken: string;
  readonly clients: AuthenticationClients;
  readonly publicErrors: ConnectError[];
  readonly runningProcess: RunningProcess;
}
type SetupRequest = Readonly<{
  bootstrapToken: string;
  displayName: string;
  email: string;
  password: string;
}>;
type ConfiguredAdministrator = Readonly<{
  expectedAdministrator: ExpectedAdministrator;
  setupRequest: SetupRequest;
}>;
type SignedInSession = Readonly<{ authorization: string; token: string }>;
type CurrentUserInput = Readonly<{
  authorization: string;
  expectedAdministrator: ExpectedAdministrator;
  flow: AuthenticationFlow;
  phase: string;
}>;
interface AuthenticationStateRow {
  readonly account_count: string;
  readonly complete_marker_count: string;
  readonly credential_account_count: string;
  readonly user_count: string;
}

const SERVER_STATE_KEY = "server";
const CREDENTIAL_PROVIDER_ID = "credential";
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const AUTHENTICATION_STATE_QUERY = `SELECT
  (SELECT count(*) FROM "user") AS user_count,
  (SELECT count(*) FROM account) AS account_count,
  (SELECT count(*) FROM account WHERE user_id = $1 AND provider_id = $2 AND password IS NOT NULL) AS credential_account_count,
  (SELECT count(*) FROM nama_server_state WHERE "key" = $3 AND administrator_user_id = $1 AND initialized_at IS NOT NULL) AS complete_marker_count`;

const administratorRequest = (flow: AuthenticationFlow, bootstrapToken: string): SetupRequest => ({
  bootstrapToken,
  displayName: flow.displayName,
  email: flow.email,
  password: flow.password,
});
const createAdministrator = (flow: AuthenticationFlow, bootstrapToken: string) =>
  flow.clients.setup.createAdministrator(administratorRequest(flow, bootstrapToken), callOptions());
const expectSetupStatus = (flow: AuthenticationFlow, initialized: boolean, phase: string) =>
  Effect.gen(function* setupStatusAssertion() {
    const status = yield* expectRpcSuccess({
      invoke: () => flow.clients.setup.getStatus({}, callOptions()),
      phase,
    });
    expect(status.initialized).toBe(initialized);
  });
const startAuthenticationFlow = (scenario: AuthenticationScenario) =>
  Effect.gen(function* startAuthenticationFlowPhase() {
    const runningProcess = yield* startProcess(scenario.databaseUrl);
    yield* waitForBootstrapOutputOrExit(runningProcess, scenario.startupSensitiveValues);
    yield* expectReady(runningProcess);
    return {
      ...scenario,
      bootstrapToken: bootstrapTokenFrom(runningProcess),
      clients: clientsFor(runningProcess.origin),
      publicErrors: [],
      runningProcess,
    } satisfies AuthenticationFlow;
  });
const verifySetupEligibility = (flow: AuthenticationFlow) =>
  Effect.gen(function* setupEligibilityPhase() {
    yield* expectSetupStatus(flow, false, "fresh GetStatus");
    yield* expectApplicationFailure({
      expectedCode: Code.FailedPrecondition,
      expectedReason: "NOT_INITIALIZED",
      invoke: () =>
        flow.clients.authentication.signIn(
          { email: flow.email, password: flow.password },
          callOptions(),
        ),
      publicErrors: flow.publicErrors,
    });
    yield* expectApplicationFailure({
      expectedCode: Code.InvalidArgument,
      expectedFieldViolations: flow.invalidSetupFieldViolations,
      expectedReason: "VALIDATION_FAILED",
      invoke: () =>
        flow.clients.setup.createAdministrator(
          {
            bootstrapToken: flow.bootstrapToken,
            displayName: "",
            email: "not-an-email",
            password: "short",
          },
          callOptions(),
        ),
      publicErrors: flow.publicErrors,
    });
    yield* expectSetupStatus(flow, false, "post-validation GetStatus");
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "AUTHENTICATION_FAILED",
      invoke: () => createAdministrator(flow, flow.wrongBootstrapToken),
      publicErrors: flow.publicErrors,
    });
    yield* expectSetupStatus(flow, false, "post-wrong-token GetStatus");
  });
const expectedConcurrentSetupResults = <Result>(
  setupAttempts: readonly PromiseSettledResult<Result>[],
) => {
  const successfulSetup = setupAttempts.find((attempt) => attempt.status === "fulfilled");
  const rejectedSetup = setupAttempts.find((attempt) => attempt.status === "rejected");
  if (successfulSetup === undefined || successfulSetup.status !== "fulfilled") {
    throw new Error("expected one successful setup attempt");
  }
  if (rejectedSetup === undefined || rejectedSetup.status !== "rejected") {
    throw new Error("expected one rejected setup attempt");
  }
  return { rejectedSetup, successfulSetup };
};
const completeAdministratorSetup = (flow: AuthenticationFlow) =>
  Effect.gen(function* concurrentSetupPhase() {
    const setupAttempts = yield* Effect.promise(() =>
      Promise.allSettled([
        createAdministrator(flow, flow.bootstrapToken),
        createAdministrator(flow, flow.bootstrapToken),
      ]),
    );
    const setupResults = expectedConcurrentSetupResults(setupAttempts);
    const { administrator: setupAdministrator } = setupResults.successfulSetup.value;
    const administrator = administratorFromSetup(setupAdministrator);
    expect(
      Object.keys(setupResults.successfulSetup.value).filter((field) => field !== "$typeName"),
    ).toEqual(["administrator"]);
    expect(administrator.id).not.toBe("");
    const expectedAdministrator = {
      displayName: flow.displayName,
      email: flow.email,
      id: administrator.id,
    };
    expectAdministrator(administrator, expectedAdministrator);
    flow.publicErrors.push(
      expectApplicationError({
        error: setupResults.rejectedSetup.reason,
        expectedCode: Code.Aborted,
        expectedReason: "SETUP_IN_PROGRESS",
      }),
    );
    return {
      expectedAdministrator,
      setupRequest: administratorRequest(flow, flow.bootstrapToken),
    } satisfies ConfiguredAdministrator;
  });
const expectAuthenticationDatabaseState = (flow: AuthenticationFlow, administratorId: string) =>
  withPool(flow.databaseUrl, (observer) =>
    Effect.gen(function* authenticationPersistenceAssertion() {
      const result = yield* Effect.promise(() =>
        observer.query<AuthenticationStateRow>(AUTHENTICATION_STATE_QUERY, [
          administratorId,
          CREDENTIAL_PROVIDER_ID,
          SERVER_STATE_KEY,
        ]),
      );
      expect(result.rows).toEqual([
        {
          account_count: "1",
          complete_marker_count: "1",
          credential_account_count: "1",
          user_count: "1",
        },
      ]);
    }),
  );
const verifySetupPersistence = (flow: AuthenticationFlow, configured: ConfiguredAdministrator) =>
  Effect.gen(function* setupPersistencePhase() {
    yield* expectAuthenticationDatabaseState(flow, configured.expectedAdministrator.id);
    yield* expectApplicationFailure({
      expectedCode: Code.FailedPrecondition,
      expectedReason: "ALREADY_INITIALIZED",
      invoke: () => flow.clients.setup.createAdministrator(configured.setupRequest, callOptions()),
      publicErrors: flow.publicErrors,
    });
    yield* expectSetupStatus(flow, true, "configured GetStatus");
  });
const verifySignInFailureParity = (flow: AuthenticationFlow) =>
  Effect.gen(function* signInFailureParityPhase() {
    const { clients, email, password, publicErrors, unknownEmail, wrongPassword } = flow;
    const unknownEmailFailure = yield* expectAuthenticationFailure({
      invoke: () => clients.authentication.signIn({ email: unknownEmail, password }, callOptions()),
      publicErrors,
    });
    const wrongPasswordFailure = yield* expectAuthenticationFailure({
      invoke: () =>
        clients.authentication.signIn({ email, password: wrongPassword }, callOptions()),
      publicErrors,
    });
    expect(credentialFailureShape(unknownEmailFailure)).toEqual(
      credentialFailureShape(wrongPasswordFailure),
    );
  });
const signInAdministrator = (
  flow: AuthenticationFlow,
  expectedAdministrator: ExpectedAdministrator,
  phase: string,
) =>
  Effect.gen(function* signInPhase() {
    const signInStartedAt = Date.now();
    const signIn = yield* expectRpcSuccess({
      invoke: () =>
        flow.clients.authentication.signIn(
          { email: flow.email, password: flow.password },
          callOptions(),
        ),
      phase,
    });
    const { credential } = signIn;
    if (credential === undefined || credential.expiresAt === undefined) {
      throw new Error("expected signed bearer credential with expiry");
    }
    expect(credential.token).toMatch(flow.signedBearerPattern);
    const expiryMilliseconds =
      Number(credential.expiresAt.seconds) * MILLISECONDS_PER_SECOND +
      Math.floor(credential.expiresAt.nanos / NANOSECONDS_PER_MILLISECOND);
    expect(expiryMilliseconds).toBeGreaterThan(signInStartedAt);
    expectAdministrator(signIn.administrator, expectedAdministrator);
    return {
      authorization: `Bearer ${credential.token}`,
      token: credential.token,
    } satisfies SignedInSession;
  });
const verifyCurrentUser = (input: CurrentUserInput) =>
  Effect.gen(function* currentUserPhase() {
    const currentUser = yield* expectRpcSuccess({
      invoke: () =>
        input.flow.clients.authentication.getCurrentUser({}, callOptions(input.authorization)),
      phase: input.phase,
    });
    expectAdministrator(currentUser.administrator, input.expectedAdministrator);
  });
export {
  completeAdministratorSetup,
  signInAdministrator,
  startAuthenticationFlow,
  verifyCurrentUser,
  verifySetupEligibility,
  verifySetupPersistence,
  verifySignInFailureParity,
};
export type {
  AuthenticationFlow,
  AuthenticationScenario,
  ConfiguredAdministrator,
  CurrentUserInput,
  ExpectedAdministrator,
  SignedInSession,
  SetupRequest,
};
