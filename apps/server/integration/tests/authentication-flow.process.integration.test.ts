import type { ConnectError } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
import { Effect } from "effect";

import type {
  AuthenticationFlow,
  AuthenticationScenario,
  ExpectedAdministrator,
  SignedInSession,
} from "./authentication-flow.test-support.ts";
import {
  completeAdministratorSetup,
  signInAdministrator,
  startAuthenticationFlow,
  verifyCurrentUser,
  verifySetupEligibility,
  verifySetupPersistence,
  verifySignInFailureParity,
} from "./authentication-flow.test-support.ts";
import type { ExpectedFieldViolation } from "./authentication-process.test-support.ts";
import {
  callOptions,
  clientsFor,
  expectApplicationFailure,
  expectConnectFailure,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";
import {
  MASTER_KEY,
  bootstrapLinesFrom,
  startProcess,
  structuredLinesFrom,
} from "./process.test-support.ts";

interface SignOutInput {
  readonly expectedAdministrator: ExpectedAdministrator;
  readonly firstSession: SignedInSession;
  readonly flow: AuthenticationFlow;
  readonly secondSession: SignedInSession;
}

const NO_BOOTSTRAP_OUTPUT = 0;
const EMPTY_VALUE_LENGTH = 0;
const INTEGRATION_TIMEOUT_MILLISECONDS = 30_000;
const ADMINISTRATOR_EMAIL = "administrator@authentication-flow.test";
const UNKNOWN_EMAIL = "unknown@authentication-flow.test";
const ADMINISTRATOR_DISPLAY_NAME = "Authentication Flow Administrator";
const ADMINISTRATOR_PASSWORD = "administrator-password-for-authentication-flow";
const WRONG_PASSWORD = "wrong-password-for-authentication-flow";
const WRONG_BOOTSTRAP_TOKEN = "wrong-bootstrap-token-for-authentication-flow";
const MALFORMED_BEARER = "Bearer not-a-signed-bearer";
const SIGNED_BEARER_PATTERN = /^[A-Za-z0-9]{32}\.[A-Za-z0-9+/]{43}=$/u;
const INVALID_SETUP_FIELD_VIOLATIONS: readonly ExpectedFieldViolation[] = [
  { description: "is required", field: "display_name", reason: "REQUIRED" },
  { description: "has an invalid format", field: "email", reason: "INVALID_FORMAT" },
  { description: "is outside the permitted range", field: "password", reason: "OUT_OF_RANGE" },
];

const publicErrorContents = (error: ConnectError): string =>
  JSON.stringify({
    badRequest: error.findDetails(BadRequestSchema),
    errorInfo: error.findDetails(ErrorInfoSchema),
    metadata: [...error.metadata.entries()],
    rawMessage: error.rawMessage,
    requestInfo: error.findDetails(RequestInfoSchema),
  });
const expectValuesAbsent = (contents: readonly string[], values: readonly string[]): void => {
  for (const value of values) {
    if (value.length !== EMPTY_VALUE_LENGTH) {
      for (const content of contents) {
        expect(content).not.toContain(value);
      }
    }
  }
};
const expectSensitiveValuesAbsent = (
  runningProcess: RunningProcess,
  publicErrors: readonly ConnectError[],
  values: readonly string[],
): void => {
  expectValuesAbsent(
    [
      runningProcess.stderr(),
      structuredLinesFrom(runningProcess).join("\n"),
      ...publicErrors.map((error) => publicErrorContents(error)),
    ],
    values,
  );
};
const verifyBearerGuards = (flow: AuthenticationFlow, firstSession: SignedInSession) =>
  Effect.gen(function* bearerGuardPhase() {
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () => flow.clients.authentication.getCurrentUser({}, callOptions()),
      publicErrors: flow.publicErrors,
    });
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () => flow.clients.authentication.getCurrentUser({}, callOptions(MALFORMED_BEARER)),
      publicErrors: flow.publicErrors,
    });
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () => flow.clients.health.check({}, callOptions()),
      publicErrors: flow.publicErrors,
    });
    yield* expectConnectFailure({
      expectedCode: Code.Unimplemented,
      invoke: () => flow.clients.health.check({}, callOptions(firstSession.authorization)),
      publicErrors: flow.publicErrors,
    });
  });
const verifySignOut = (input: SignOutInput) =>
  Effect.gen(function* signOutPhase() {
    yield* expectRpcSuccess({
      invoke: () =>
        input.flow.clients.authentication.signOut(
          {},
          callOptions(input.firstSession.authorization),
        ),
      phase: "first-session SignOut",
    });
    yield* expectApplicationFailure({
      expectedCode: Code.Unauthenticated,
      expectedReason: "CREDENTIAL_INVALID",
      invoke: () =>
        input.flow.clients.authentication.getCurrentUser(
          {},
          callOptions(input.firstSession.authorization),
        ),
      publicErrors: input.flow.publicErrors,
    });
    yield* verifyCurrentUser({
      authorization: input.secondSession.authorization,
      expectedAdministrator: input.expectedAdministrator,
      flow: input.flow,
      phase: "second-session GetCurrentUser",
    });
  });
const verifyConfiguredRestart = (flow: AuthenticationFlow, sensitiveValues: readonly string[]) =>
  Effect.gen(function* restartPersistencePhase() {
    const restartedProcess = yield* startProcess(flow.databaseUrl);
    yield* expectReady(restartedProcess);
    expect(bootstrapLinesFrom(restartedProcess)).toHaveLength(NO_BOOTSTRAP_OUTPUT);
    const restartedClients = clientsFor(restartedProcess.origin);
    const restartedStatus = yield* expectRpcSuccess({
      invoke: () => restartedClients.setup.getStatus({}, callOptions()),
      phase: "restart GetStatus",
    });
    expect(restartedStatus.initialized).toBe(true);
    yield* stopCleanly(restartedProcess);
    expectSensitiveValuesAbsent(restartedProcess, [], sensitiveValues);
  });

const scenarioFor = (databaseUrl: string): AuthenticationScenario => {
  const databaseLocation = new URL(databaseUrl);
  return {
    databaseUrl,
    displayName: ADMINISTRATOR_DISPLAY_NAME,
    email: ADMINISTRATOR_EMAIL,
    invalidSetupFieldViolations: INVALID_SETUP_FIELD_VIOLATIONS,
    password: ADMINISTRATOR_PASSWORD,
    signedBearerPattern: SIGNED_BEARER_PATTERN,
    startupSensitiveValues: [
      ADMINISTRATOR_EMAIL,
      ADMINISTRATOR_DISPLAY_NAME,
      ADMINISTRATOR_PASSWORD,
      WRONG_PASSWORD,
      WRONG_BOOTSTRAP_TOKEN,
      MALFORMED_BEARER,
      databaseUrl,
      databaseLocation.hostname,
      databaseLocation.pathname,
      databaseLocation.port,
      MASTER_KEY,
      UNKNOWN_EMAIL,
    ],
    unknownEmail: UNKNOWN_EMAIL,
    wrongBootstrapToken: WRONG_BOOTSTRAP_TOKEN,
    wrongPassword: WRONG_PASSWORD,
  };
};

const configureAdministrator = (flow: AuthenticationFlow) =>
  Effect.gen(function* setupPhase() {
    yield* verifySetupEligibility(flow);
    const configured = yield* completeAdministratorSetup(flow);
    yield* verifySetupPersistence(flow, configured);
    yield* verifySignInFailureParity(flow);
    return configured;
  });
const signInAndVerify = (flow: AuthenticationFlow, expectedAdministrator: ExpectedAdministrator) =>
  Effect.gen(function* signInAndCurrentUserPhase() {
    const firstSession = yield* signInAdministrator(
      flow,
      expectedAdministrator,
      "first administrator SignIn",
    );
    yield* verifyCurrentUser({
      authorization: firstSession.authorization,
      expectedAdministrator,
      flow,
      phase: "first administrator GetCurrentUser",
    });
    yield* verifyBearerGuards(flow, firstSession);
    return firstSession;
  });
const verifySessionLifecycle = (
  flow: AuthenticationFlow,
  firstSession: SignedInSession,
  expectedAdministrator: ExpectedAdministrator,
) =>
  Effect.gen(function* sessionLifecyclePhase() {
    const secondSession = yield* signInAdministrator(
      flow,
      expectedAdministrator,
      "second administrator SignIn",
    );
    expect(secondSession.token).not.toBe(firstSession.token);
    yield* verifySignOut({ expectedAdministrator, firstSession, flow, secondSession });
    return secondSession;
  });
const runAuthenticationFlow = (databaseUrl: string) =>
  Effect.gen(function* authenticationFlowProcessTest() {
    const flow = yield* startAuthenticationFlow(scenarioFor(databaseUrl));
    const configured = yield* configureAdministrator(flow);
    const firstSession = yield* signInAndVerify(flow, configured.expectedAdministrator);
    const secondSession = yield* verifySessionLifecycle(
      flow,
      firstSession,
      configured.expectedAdministrator,
    );
    const sensitiveValues = [
      ...flow.startupSensitiveValues,
      flow.bootstrapToken,
      firstSession.token,
      firstSession.authorization,
      secondSession.token,
      secondSession.authorization,
    ];
    yield* stopCleanly(flow.runningProcess);
    expectSensitiveValuesAbsent(flow.runningProcess, flow.publicErrors, sensitiveValues);
    yield* verifyConfiguredRestart(flow, sensitiveValues);
  });
it.live(
  "runs setup and administrator authentication through the package entrypoint",
  () =>
    withIsolatedDatabase((databaseUrl) => runAuthenticationFlow(databaseUrl).pipe(Effect.scoped)),
  INTEGRATION_TIMEOUT_MILLISECONDS,
);
