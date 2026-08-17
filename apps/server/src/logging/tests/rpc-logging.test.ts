import { Code } from "@connectrpc/connect";
import { expect, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";

import { Config } from "../../config/config.ts";
import { configuredLoggingLayer, logEvent, logRpcCompletion } from "../logging.ts";
import type { RpcCompletionRecord } from "../logging.ts";

const FIRST_RECORD_INDEX = 0;
const SECOND_RECORD_INDEX = 1;
const SINGLE_RECORD_COUNT = 1;
const MULTIPLE_RECORD_COUNT = 2;
const SUCCESS_CODE = 0;
const INVALID_ARGUMENT_CODE = 3;
const UNAUTHENTICATED_CODE = 16;

const infoConfig = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("postgres://secret") }),
  logging: Object.freeze({ level: "info" as const }),
  security: Object.freeze({ masterKey: Redacted.make("master-secret") }),
  server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://127.0.0.1:8080/" }),
});
const warnConfig = Config.of({
  database: Object.freeze({ maxConnections: 1, url: Redacted.make("postgres://secret") }),
  logging: Object.freeze({ level: "warn" as const }),
  security: Object.freeze({ masterKey: Redacted.make("master-secret") }),
  server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: "http://127.0.0.1:8080/" }),
});

const SUCCESSFUL_COMPLETION: RpcCompletionRecord = Object.freeze({
  code: SUCCESS_CODE,
  durationMs: 12,
  event: "rpc.completed",
  method: "nama.api.v1.SetupService.GetStatus",
  requestId: "request-success",
});

const UNSAFE_BEARER = "Bearer do-not-serialize";
const UNSAFE_EMAIL = "administrator@example.com";
const UNSAFE_EMAIL_DIGEST = "do-not-serialize-email-digest";
const UNSAFE_BODY = '{"password":"do-not-serialize"}';
const UNSAFE_URL = "https://example.test/rpc?token=do-not-serialize";
const UNSAFE_HEADERS = "authorization: Bearer do-not-serialize";
const UNSAFE_PRIVATE_FAILURE = "private database failure";
const UNSAFE_STACK_FRAME = "at privateFailure (internal.ts:1:1)";
const UNSAFE_VALUES = [
  UNSAFE_BEARER,
  UNSAFE_EMAIL,
  UNSAFE_EMAIL_DIGEST,
  UNSAFE_BODY,
  UNSAFE_URL,
  UNSAFE_HEADERS,
  UNSAFE_PRIVATE_FAILURE,
  UNSAFE_STACK_FRAME,
] as const;

type RpcCompletionRecordWithUnsafeProperties = RpcCompletionRecord &
  Readonly<{
    readonly authorization: string;
    readonly body: string;
    readonly email: string;
    readonly emailDigest: string;
    readonly errorTag: string;
    readonly headers: string;
    readonly privateFailure: string;
    readonly sanitizedStackFrames: readonly string[];
    readonly stack: string;
    readonly url: string;
  }>;

const EXPECTED_CLIENT_ERROR_COMPLETION: RpcCompletionRecordWithUnsafeProperties = Object.freeze({
  authorization: UNSAFE_BEARER,
  body: UNSAFE_BODY,
  code: Code.InvalidArgument,
  durationMs: 7,
  email: UNSAFE_EMAIL,
  emailDigest: UNSAFE_EMAIL_DIGEST,
  errorTag: "PrivateAuthenticationDefect",
  event: "rpc.completed",
  headers: UNSAFE_HEADERS,
  method: "nama.api.v1.AuthService.SignIn",
  privateFailure: UNSAFE_PRIVATE_FAILURE,
  requestId: "request-invalid-argument",
  sanitizedStackFrames: [UNSAFE_STACK_FRAME],
  stack: UNSAFE_STACK_FRAME,
  url: UNSAFE_URL,
});

const UNAUTHENTICATED_COMPLETION: RpcCompletionRecord = Object.freeze({
  code: Code.Unauthenticated,
  durationMs: 3,
  event: "rpc.completed",
  method: "nama.api.v1.AuthService.GetCurrentUser",
  requestId: "request-unauthenticated",
});

const isStructuredRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordFromLine = (line: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(line);
  if (!isStructuredRecord(parsed)) {
    throw new TypeError("expected a structured log record");
  }
  return parsed;
};

const expectRpcCompletionRecord = (
  record: Readonly<Record<string, unknown>>,
  expected: Readonly<{
    readonly code: number;
    readonly durationMs: number;
    readonly method: string;
    readonly requestId: string;
  }>,
): void => {
  expect(typeof record["timestamp"]).toBe("string");
  expect(record).toEqual({
    connect_code: expected.code,
    duration_ms: expected.durationMs,
    event: "rpc.completed",
    level: "info",
    request_id: expected.requestId,
    rpc_method: expected.method,
    timestamp: record["timestamp"],
  });
};

/**
 * `connect_code` is the numeric Connect wire code carried by the request
 * pipeline. Success is 0; expected error codes use @connectrpc/connect's
 * numeric `Code` enum. The named assertion constants pin INVALID_ARGUMENT to 3
 * and UNAUTHENTICATED to 16.
 */
it.effect("writes one allowlisted info-level JSON record for a successful RPC", () =>
  Effect.gen(function* successfulRpcCompletionLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(infoConfig, (line) => {
      lines.push(line);
    });

    yield* logRpcCompletion(SUCCESSFUL_COMPLETION).pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    expect(lines[FIRST_RECORD_INDEX]?.endsWith("\n")).toBe(true);
    expectRpcCompletionRecord(recordFromLine(lines[FIRST_RECORD_INDEX] ?? ""), {
      code: SUCCESS_CODE,
      durationMs: 12,
      method: "nama.api.v1.SetupService.GetStatus",
      requestId: "request-success",
    });
  }),
);

it.effect("keeps expected client RPC errors allowlisted and code-specific", () =>
  Effect.gen(function* expectedClientErrorRpcLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(infoConfig, (line) => {
      lines.push(line);
    });
    const program = Effect.gen(function* expectedClientErrorProgram() {
      yield* logRpcCompletion(EXPECTED_CLIENT_ERROR_COMPLETION);
      yield* logRpcCompletion(UNAUTHENTICATED_COMPLETION);
    });

    yield* program.pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(MULTIPLE_RECORD_COUNT);
    expectRpcCompletionRecord(recordFromLine(lines[FIRST_RECORD_INDEX] ?? ""), {
      code: INVALID_ARGUMENT_CODE,
      durationMs: 7,
      method: "nama.api.v1.AuthService.SignIn",
      requestId: "request-invalid-argument",
    });
    expectRpcCompletionRecord(recordFromLine(lines[SECOND_RECORD_INDEX] ?? ""), {
      code: UNAUTHENTICATED_CODE,
      durationMs: 3,
      method: "nama.api.v1.AuthService.GetCurrentUser",
      requestId: "request-unauthenticated",
    });
    for (const unsafeValue of UNSAFE_VALUES) {
      expect(lines.join("")).not.toContain(unsafeValue);
    }
  }),
);

it.effect("filters RPC completion records when the configured minimum excludes info", () =>
  Effect.gen(function* filteredRpcCompletionLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(warnConfig, (line) => {
      lines.push(line);
    });

    yield* logRpcCompletion(SUCCESSFUL_COMPLETION).pipe(Effect.provide(loggingLayer));

    expect(lines).toEqual([]);
  }),
);

it.effect("keeps existing generic event records compatible with the structured logger", () =>
  Effect.gen(function* genericEventLoggingTest() {
    const lines: string[] = [];
    const loggingLayer = configuredLoggingLayer(infoConfig, (line) => {
      lines.push(line);
    });

    yield* logEvent("server.ready", { durationMs: 5 }).pipe(Effect.provide(loggingLayer));

    expect(lines).toHaveLength(SINGLE_RECORD_COUNT);
    const record = recordFromLine(lines[FIRST_RECORD_INDEX] ?? "");
    expect(typeof record["timestamp"]).toBe("string");
    expect(record).toEqual({
      duration_ms: 5,
      event: "server.ready",
      level: "info",
      timestamp: record["timestamp"],
    });
  }),
);
