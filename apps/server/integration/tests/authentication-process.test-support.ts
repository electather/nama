import type { CallOptions, Client, Code } from "@connectrpc/connect";
import { ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect } from "@effect/vitest";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { Clock, Effect } from "effect";

import type { ExpectedFieldViolation } from "./authentication-details.test-support.ts";
import { expectApplicationError } from "./authentication-details.test-support.ts";
import type { RunningProcess } from "./process.test-support.ts";
import {
  bootstrapLinesFrom,
  eventsFrom,
  expectPortReleased,
  stopProcess,
  waitForStatus,
} from "./process.test-support.ts";

type RouteExpectation = Readonly<{ method: "GET" | "POST"; path: string; status: number }>;
type AuthenticationClients = Readonly<{
  authentication: Client<typeof AuthService>;
  health: Client<typeof HealthService>;
  setup: Client<typeof SetupService>;
}>;
type ApplicationFailureInput = Readonly<{
  expectedCode: Code;
  expectedFieldViolations?: readonly ExpectedFieldViolation[];
  expectedReason: string;
  invoke: () => Promise<unknown>;
  publicErrors: ConnectError[];
}>;
type ConnectFailureInput = Readonly<{
  expectedCode: Code;
  invoke: () => Promise<unknown>;
  publicErrors: ConnectError[];
}>;
type RpcSuccessInput<Result> = Readonly<{ invoke: () => Promise<Result>; phase: string }>;
type BootstrapPollInput = Readonly<{
  deadline: number;
  runningProcess: RunningProcess;
  unsafeValues: readonly string[];
}>;
const HTTP_NOT_FOUND = 404;
const HTTP_OK = 200;
const SUCCESS_EXIT_CODE = 0;
const FIRST_INDEX = 0;
const EXPECTED_SINGLE_ITEM = 1;
const EMPTY_COLLECTION_LENGTH = 0;
const NO_PROCESS_EXIT = new URLSearchParams().get("exit-signal");
const STARTUP_WAIT_MILLISECONDS = 6000;
const STARTUP_POLL_MILLISECONDS = 25;
const RPC_TIMEOUT_MILLISECONDS = 5000;
const STOP_SIGNAL = "SIGTERM";
const BOOTSTRAP_TOKEN_LINE_PATTERN = /^NAMA_BOOTSTRAP_TOKEN=(?<token>.+)$/u;
const UNSAFE_STDERR_PATTERN =
  /(?:authorization|bootstrap|config|credential|database|master(?:[_ -]?key)?|password|secret|token|url)/iu;
const HEALTH_ROUTE_EXPECTATIONS: readonly RouteExpectation[] = [
  { method: "GET", path: "/health/live", status: HTTP_OK },
  { method: "GET", path: "/health/ready", status: HTTP_OK },
  { method: "GET", path: "/health/live/", status: HTTP_NOT_FOUND },
  { method: "GET", path: "/health/live?not-an-exact-health-route=true", status: HTTP_NOT_FOUND },
  { method: "POST", path: "/health/live", status: HTTP_NOT_FOUND },
  { method: "GET", path: "/api/auth/sign-in/email", status: HTTP_NOT_FOUND },
  { method: "GET", path: "/nama.plugin.v1.PluginService/GetInfo", status: HTTP_NOT_FOUND },
  { method: "GET", path: "/nama.api.v1.UnknownService/UnknownMethod", status: HTTP_NOT_FOUND },
];

const structuredEventNames = (runningProcess: RunningProcess): readonly string[] => {
  try {
    return eventsFrom(runningProcess);
  } catch {
    return [];
  }
};
const firstNonEmptyLine = (output: string): string | undefined => {
  for (const line of output.split("\n")) {
    if (line.length !== EMPTY_COLLECTION_LENGTH) {
      return line;
    }
  }
  return undefined;
};
const containsUnsafeValue = (values: readonly string[], content: string): boolean => {
  for (const value of values) {
    if (value.length !== EMPTY_COLLECTION_LENGTH && content.includes(value)) {
      return true;
    }
  }
  return false;
};
const processHasExited = (runningProcess: RunningProcess): boolean =>
  runningProcess.child.exitCode !== NO_PROCESS_EXIT ||
  runningProcess.child.signalCode !== NO_PROCESS_EXIT;
const bootstrapOutputAvailable = (runningProcess: RunningProcess): boolean =>
  bootstrapLinesFrom(runningProcess).length !== EMPTY_COLLECTION_LENGTH;
const firstSafeStderrLine = (input: {
  readonly runningProcess: RunningProcess;
  readonly unsafeValues: readonly string[];
}): string | undefined => {
  const firstLine = firstNonEmptyLine(input.runningProcess.stderr());
  if (firstLine === undefined) {
    return undefined;
  }
  if (UNSAFE_STDERR_PATTERN.test(firstLine) || firstLine.includes(input.runningProcess.origin)) {
    return undefined;
  }
  if (containsUnsafeValue(input.unsafeValues, firstLine)) {
    return undefined;
  }
  return firstLine;
};
const earlyProcessExitDiagnostic = (input: {
  readonly runningProcess: RunningProcess;
  readonly unsafeValues: readonly string[];
}): string => {
  const diagnostic = {
    code: input.runningProcess.child.exitCode,
    events: structuredEventNames(input.runningProcess),
    signal: input.runningProcess.child.signalCode,
  };
  const firstStderrLine = firstSafeStderrLine(input);
  if (firstStderrLine === undefined) {
    return JSON.stringify(diagnostic);
  }
  return JSON.stringify({ ...diagnostic, firstStderrLine });
};
const pollForBootstrapOutputOrExit = (input: BootstrapPollInput): Effect.Effect<void> =>
  Effect.gen(function* bootstrapOutputPoll() {
    if (processHasExited(input.runningProcess)) {
      yield* Effect.die(
        new Error(`process exited before bootstrap output: ${earlyProcessExitDiagnostic(input)}`),
      );
    }
    if (bootstrapOutputAvailable(input.runningProcess)) {
      return;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= input.deadline) {
      yield* Effect.die(new Error("timed out waiting for bootstrap output"));
    }
    yield* Effect.sleep(STARTUP_POLL_MILLISECONDS);
    yield* pollForBootstrapOutputOrExit(input);
  });
const waitForBootstrapOutputOrExit = (
  runningProcess: RunningProcess,
  unsafeValues: readonly string[],
) =>
  Effect.gen(function* bootstrapOutputWait() {
    const now = yield* Clock.currentTimeMillis;
    yield* pollForBootstrapOutputOrExit({
      deadline: now + STARTUP_WAIT_MILLISECONDS,
      runningProcess,
      unsafeValues,
    });
  });
const callOptions = (authorization?: string): CallOptions => {
  if (authorization === undefined) {
    return { timeoutMs: RPC_TIMEOUT_MILLISECONDS };
  }
  return { headers: { authorization }, timeoutMs: RPC_TIMEOUT_MILLISECONDS };
};
const clientsFor = (origin: string): AuthenticationClients => {
  const transport = createConnectTransport({ baseUrl: origin, httpVersion: "1.1" });
  return {
    authentication: createClient(AuthService, transport),
    health: createClient(HealthService, transport),
    setup: createClient(SetupService, transport),
  };
};
const expectOperationalRoute = (origin: string, route: RouteExpectation) =>
  Effect.promise(async () => {
    const response = await fetch(new URL(route.path, origin), {
      method: route.method,
      signal: AbortSignal.timeout(RPC_TIMEOUT_MILLISECONDS),
    });
    const body = await response.text();
    expect(response.status).toBe(route.status);
    if (route.status === HTTP_OK) {
      expect(body).toBe("");
    }
  });
const expectExactOperationalRoutes = (origin: string) =>
  Effect.gen(function* operationalRoutesAssertion() {
    for (const route of HEALTH_ROUTE_EXPECTATIONS) {
      yield* expectOperationalRoute(origin, route);
    }
  });
const expectReady = (runningProcess: RunningProcess) =>
  Effect.gen(function* readyProcessAssertion() {
    yield* waitForStatus(runningProcess.origin, "/health/live", HTTP_OK);
    yield* waitForStatus(runningProcess.origin, "/health/ready", HTTP_OK);
    yield* expectExactOperationalRoutes(runningProcess.origin);
  });
const applicationErrorFromFailure = (
  error: unknown,
  input: ApplicationFailureInput,
): ConnectError => {
  const { expectedCode, expectedFieldViolations, expectedReason } = input;
  if (expectedFieldViolations === undefined) {
    return expectApplicationError({ error, expectedCode, expectedReason });
  }
  return expectApplicationError({ error, expectedCode, expectedFieldViolations, expectedReason });
};
const expectApplicationFailure = (input: ApplicationFailureInput) =>
  Effect.promise(async () => {
    try {
      await input.invoke();
    } catch (error) {
      const applicationError = applicationErrorFromFailure(error, input);
      input.publicErrors.push(applicationError);
      return applicationError;
    }
    throw new Error(`expected ${input.expectedReason} application failure`);
  });
const expectConnectFailure = (input: ConnectFailureInput) =>
  Effect.promise(async () => {
    try {
      await input.invoke();
    } catch (error) {
      if (!(error instanceof ConnectError)) {
        throw new Error("expected Connect RPC failure", { cause: error });
      }
      input.publicErrors.push(error);
      expect(error.code).toBe(input.expectedCode);
      return error;
    }
    throw new Error(`expected ${input.expectedCode} Connect failure`);
  });
const expectRpcSuccess = <Result>(input: RpcSuccessInput<Result>) =>
  Effect.promise(async () => {
    try {
      return await input.invoke();
    } catch (error) {
      if (!(error instanceof ConnectError)) {
        throw new Error(`unexpected non-Connect RPC failure during ${input.phase}`, {
          cause: error,
        });
      }
      const reason = error.findDetails(ErrorInfoSchema).at(FIRST_INDEX)?.reason;
      throw new Error(JSON.stringify({ code: error.code, phase: input.phase, reason }), {
        cause: error,
      });
    }
  });
const bootstrapLineFrom = (runningProcess: RunningProcess): string => {
  const bootstrapLines = bootstrapLinesFrom(runningProcess);
  expect(bootstrapLines).toHaveLength(EXPECTED_SINGLE_ITEM);
  const bootstrapLine = bootstrapLines.at(FIRST_INDEX);
  if (bootstrapLine === undefined) {
    throw new Error("expected a bootstrap token line");
  }
  return bootstrapLine;
};
const bootstrapTokenFrom = (runningProcess: RunningProcess): string => {
  const bootstrapLine = bootstrapLineFrom(runningProcess);
  const bootstrapMatch = BOOTSTRAP_TOKEN_LINE_PATTERN.exec(bootstrapLine);
  if (!bootstrapMatch) {
    throw new Error("expected a bootstrap token match");
  }
  const token = bootstrapMatch.groups?.["token"];
  if (token === undefined) {
    throw new Error("expected a bootstrap token capture");
  }
  expect(token).not.toBe("");
  return token;
};
const stopCleanly = (runningProcess: RunningProcess) =>
  Effect.gen(function* cleanProcessStop() {
    const exit = yield* stopProcess(runningProcess, STOP_SIGNAL);
    expect(exit.code).toBe(SUCCESS_EXIT_CODE);
    expect(exit.signal).toBeNull();
    yield* expectPortReleased(runningProcess.origin);
  });
export {
  bootstrapTokenFrom,
  callOptions,
  clientsFor,
  expectApplicationError,
  expectApplicationFailure,
  expectConnectFailure,
  expectReady,
  expectRpcSuccess,
  stopCleanly,
  waitForBootstrapOutputOrExit,
};
export type {
  ApplicationFailureInput,
  AuthenticationClients,
  ConnectFailureInput,
  ExpectedFieldViolation,
  RpcSuccessInput,
};
