import { Code } from "@connectrpc/connect";
import { Effect } from "effect";
import type { Pool } from "pg";

import {
  ADMINISTRATOR,
  GLOBAL_RATE_WINDOW_MILLISECONDS,
  GLOBAL_SIGN_IN_ATTEMPT_COUNT,
  IDENTITY_RATE_WINDOW_MILLISECONDS,
  IDENTITY_SIGN_IN_ATTEMPT_COUNT,
  INVALID_GLOBAL_EMAIL,
  INVALID_GLOBAL_PASSWORD,
  INVALID_SIGN_IN_FIELD_VIOLATIONS,
  UPPERCASE_ADMINISTRATOR_EMAIL,
  WRONG_PASSWORD,
  expectRateLimited,
  rawSessionTokenFromBearer,
} from "./authentication-failures.test-support.ts";
import type { FailureState } from "./authentication-failures.test-support.ts";
import {
  callOptions,
  clientsFor,
  expectApplicationFailure,
  expectReady,
  stopCleanly,
} from "./authentication-process.test-support.ts";
import type {
  AuthenticationClients,
  ExpectedFieldViolation,
} from "./authentication-process.test-support.ts";
import { withPool } from "./database.test-support.ts";
import { withAdminPool } from "./postgres.test-support.ts";
import { startProcess } from "./process.test-support.ts";

type FailurePhaseInput = Readonly<{ databaseUrl: string; state: FailureState }>;
type FormattedStatementRow = Readonly<{ statement: string }>;
type SessionDeleteFaultInput = Readonly<{
  authorization: string;
  databaseUrl: string;
  use: Effect.Effect<void>;
}>;
type DatabaseOutageInput = Readonly<{
  databaseUrl: string;
  use: Effect.Effect<void>;
}>;
type LimiterPhase = Readonly<{
  attemptCount: number;
  expectedCode: Code;
  expectedFieldViolations?: readonly ExpectedFieldViolation[];
  expectedReason: string;
  invokeAttempt: (clients: AuthenticationClients, attempt: number) => Promise<unknown>;
  invokeRateLimited: (clients: AuthenticationClients) => Promise<unknown>;
  retryLimitMilliseconds: number;
}>;
const FIRST_SIGN_IN_ATTEMPT = 1;
const UPPERCASE_EMAIL_ATTEMPT_REMAINDER = 0;
const EVEN_ATTEMPT_DIVISOR = 2;
const DATABASE_PATH_PREFIX_LENGTH = 1;
const EMPTY_DATABASE_NAME_LENGTH = 0;

const FIRST_FORMATTED_STATEMENT_INDEX = 0;
const TARGET_DELETE_TRIGGER = "nama_test_fail_target_session_delete";
const TARGET_DELETE_FUNCTION = "nama_test_fail_target_session_delete";
const FIXED_SESSION_DELETE_FAULT = "nama test target session deletion fault";
const expectedFieldViolationsInput = (
  expectedFieldViolations: LimiterPhase["expectedFieldViolations"],
) => {
  if (expectedFieldViolations === undefined) {
    return {} as const;
  }
  return { expectedFieldViolations } as const;
};

const startConfiguredProcess = (input: FailurePhaseInput) =>
  Effect.gen(function* configuredProcessPhase() {
    const runningProcess = yield* startProcess(input.databaseUrl);
    input.state.runningProcesses.push(runningProcess);
    yield* expectReady(runningProcess);
    return { clients: clientsFor(runningProcess.origin), runningProcess };
  });

const runLimiterPhase = (input: FailurePhaseInput, phase: LimiterPhase) =>
  Effect.acquireUseRelease(
    startProcess(input.databaseUrl),
    (runningProcess) =>
      Effect.gen(function* limiterPhase() {
        input.state.runningProcesses.push(runningProcess);
        yield* expectReady(runningProcess);
        const clients = clientsFor(runningProcess.origin);
        for (
          let attempt = FIRST_SIGN_IN_ATTEMPT;
          attempt <= phase.attemptCount;
          attempt += FIRST_SIGN_IN_ATTEMPT
        ) {
          yield* expectApplicationFailure({
            expectedCode: phase.expectedCode,
            ...expectedFieldViolationsInput(phase.expectedFieldViolations),
            expectedReason: phase.expectedReason,
            invoke: () => phase.invokeAttempt(clients, attempt),
            publicErrors: input.state.publicErrors,
          });
        }
        yield* expectRateLimited({
          invoke: () => phase.invokeRateLimited(clients),
          publicErrors: input.state.publicErrors,
          retryLimitMilliseconds: phase.retryLimitMilliseconds,
        });
      }),
    stopCleanly,
  );

const runGlobalLimiterPhase = (input: FailurePhaseInput) =>
  runLimiterPhase(input, {
    attemptCount: GLOBAL_SIGN_IN_ATTEMPT_COUNT,
    expectedCode: Code.InvalidArgument,
    expectedFieldViolations: INVALID_SIGN_IN_FIELD_VIOLATIONS,
    expectedReason: "VALIDATION_FAILED",
    invokeAttempt: (clients) =>
      clients.authentication.signIn(
        { email: INVALID_GLOBAL_EMAIL, password: INVALID_GLOBAL_PASSWORD },
        callOptions(),
      ),
    invokeRateLimited: (clients) =>
      clients.authentication.signIn(
        { email: INVALID_GLOBAL_EMAIL, password: INVALID_GLOBAL_PASSWORD },
        callOptions(),
      ),
    retryLimitMilliseconds: GLOBAL_RATE_WINDOW_MILLISECONDS,
  });

const runIdentityLimiterPhase = (input: FailurePhaseInput) =>
  runLimiterPhase(input, {
    attemptCount: IDENTITY_SIGN_IN_ATTEMPT_COUNT,
    expectedCode: Code.Unauthenticated,
    expectedReason: "AUTHENTICATION_FAILED",
    invokeAttempt: (clients, attempt) => {
      let { email }: { email: string } = ADMINISTRATOR;
      if (attempt % EVEN_ATTEMPT_DIVISOR === UPPERCASE_EMAIL_ATTEMPT_REMAINDER) {
        email = UPPERCASE_ADMINISTRATOR_EMAIL;
      }
      return clients.authentication.signIn({ email, password: WRONG_PASSWORD }, callOptions());
    },
    invokeRateLimited: (clients) =>
      clients.authentication.signIn(
        { email: UPPERCASE_ADMINISTRATOR_EMAIL, password: WRONG_PASSWORD },
        callOptions(),
      ),
    retryLimitMilliseconds: IDENTITY_RATE_WINDOW_MILLISECONDS,
  });

const formattedStatementFrom = async (input: {
  readonly format: string;
  readonly pool: Pool;
  readonly values: unknown[];
}): Promise<string> => {
  const result = await input.pool.query<FormattedStatementRow>(input.format, input.values);
  const { statement } = result.rows.at(FIRST_FORMATTED_STATEMENT_INDEX) ?? {};
  if (typeof statement !== "string") {
    throw new TypeError("expected PostgreSQL formatted statement");
  }
  return statement;
};

const installTargetSessionDeleteFault = async (input: {
  readonly pool: Pool;
  readonly sessionToken: string;
}): Promise<void> => {
  const statement = await formattedStatementFrom({
    format: `SELECT format(
      $format$
        CREATE FUNCTION ${TARGET_DELETE_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN
          RAISE EXCEPTION %L;
        END;
        $function$;
        CREATE TRIGGER ${TARGET_DELETE_TRIGGER}
          BEFORE DELETE ON "session"
          FOR EACH ROW WHEN (OLD.token = %L)
          EXECUTE FUNCTION ${TARGET_DELETE_FUNCTION}();
      $format$,
      $1::text,
      $2::text
    ) AS statement`,
    pool: input.pool,
    values: [FIXED_SESSION_DELETE_FAULT, input.sessionToken],
  });
  await input.pool.query(statement);
};

const removeTargetSessionDeleteFault = async (pool: Pool): Promise<void> => {
  await pool.query(`DROP TRIGGER IF EXISTS ${TARGET_DELETE_TRIGGER} ON "session"`);
  await pool.query(`DROP FUNCTION IF EXISTS ${TARGET_DELETE_FUNCTION}()`);
};

const withTargetSessionDeleteFault = (input: SessionDeleteFaultInput) =>
  withPool(input.databaseUrl, (observer) =>
    Effect.acquireUseRelease(
      Effect.promise(() =>
        installTargetSessionDeleteFault({
          pool: observer,
          sessionToken: rawSessionTokenFromBearer({ authorization: input.authorization }),
        }),
      ),
      () => input.use,
      () => Effect.promise(() => removeTargetSessionDeleteFault(observer)),
    ),
  );

const databaseNameFrom = (databaseUrl: string): string => {
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(DATABASE_PATH_PREFIX_LENGTH),
  );
  if (databaseName.length === EMPTY_DATABASE_NAME_LENGTH) {
    throw new Error("expected isolated database name");
  }
  return databaseName;
};

const setDatabaseConnections = async (input: {
  readonly allowConnections: boolean;
  readonly databaseName: string;
  readonly pool: Pool;
}): Promise<void> => {
  const statement = await formattedStatementFrom({
    format:
      "SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS %s', $1::text, CASE WHEN $2::boolean THEN 'TRUE' ELSE 'FALSE' END) AS statement",
    pool: input.pool,
    values: [input.databaseName, input.allowConnections],
  });
  await input.pool.query(statement);
};

const withDatabaseConnectionsDisabled = (input: DatabaseOutageInput) => {
  const databaseName = databaseNameFrom(input.databaseUrl);
  return withAdminPool((admin) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        await setDatabaseConnections({
          allowConnections: false,
          databaseName,
          pool: admin,
        });
        await admin.query(
          `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
           WHERE datname = $1
             AND pid <> pg_backend_pid()`,
          [databaseName],
        );
      }),
      () => input.use,
      () =>
        Effect.promise(() =>
          setDatabaseConnections({
            allowConnections: true,
            databaseName,
            pool: admin,
          }),
        ),
    ),
  );
};

export {
  runGlobalLimiterPhase,
  runIdentityLimiterPhase,
  startConfiguredProcess,
  withDatabaseConnectionsDisabled,
  withTargetSessionDeleteFault,
};

export type { DatabaseOutageInput, FailurePhaseInput, SessionDeleteFaultInput };
