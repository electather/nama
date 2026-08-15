import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import { makeBootstrapToken } from "../bootstrap-token.ts";

const TOKEN_BYTES = 32;
const ZERO = 0;
const ONE = 1;
const MALFORMED_CANDIDATE_LENGTH = 1024;
const ZERO_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const discardOutput = (line: string): number => line.length;

const captureOutput =
  (lines: string[]) =>
  (line: string): number => {
    lines.push(line);
    return line.length;
  };

const failed = <Success, Failure, Requirements>(
  effect: Effect.Effect<Success, Failure, Requirements>,
): Effect.Effect<Failure | false, never, Requirements> =>
  effect.pipe(Effect.match({ onFailure: (failure) => failure, onSuccess: () => false }));

it.effect("keeps configured construction inert after activation", () =>
  Effect.gen(function* configuredBootstrapTest() {
    let randomCalls = ZERO;
    const lines: string[] = [];
    const bootstrapToken = makeBootstrapToken("configured", {
      randomBytes: () => {
        randomCalls += ONE;
        return Buffer.alloc(TOKEN_BYTES);
      },
      writeLine: captureOutput(lines),
    });

    yield* bootstrapToken.activate;

    expect(randomCalls).toBe(ZERO);
    expect(lines).toEqual([]);
  }),
);

it.effect("emits one unpadded token after eligible activation", () =>
  Effect.gen(function* eligibleBootstrapTest() {
    let randomCalls = ZERO;
    const lines: string[] = [];
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => {
        randomCalls += ONE;
        return Buffer.alloc(TOKEN_BYTES);
      },
      writeLine: captureOutput(lines),
    });

    yield* bootstrapToken.activate;
    yield* bootstrapToken.activate;

    expect(randomCalls).toBe(ONE);
    expect(lines).toEqual([`NAMA_BOOTSTRAP_TOKEN=${ZERO_TOKEN}\n`]);
  }),
);

it.effect("admits only the emitted candidate", () =>
  Effect.gen(function* candidateValidationTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    const invalid = yield* failed(bootstrapToken.claim("not-the-emitted-token"));
    expect(invalid).toMatchObject({ _tag: "BootstrapTokenInvalidError" });

    const attempt = yield* bootstrapToken.claim(ZERO_TOKEN);
    expect(attempt).toBeDefined();
  }),
);

it.effect("rejects candidates before eligible activation", () =>
  Effect.gen(function* unavailableCandidateTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible");
    const unavailable = yield* failed(bootstrapToken.claim("candidate"));

    expect(unavailable).toMatchObject({ _tag: "BootstrapTokenUnavailableError" });
  }),
);

it.effect("rejects a concurrent valid claim without queuing it", () =>
  Effect.gen(function* busyCandidateTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    yield* bootstrapToken.claim(ZERO_TOKEN);
    const busy = yield* failed(bootstrapToken.claim(ZERO_TOKEN));

    expect(busy).toMatchObject({ _tag: "BootstrapTokenBusyError" });
  }),
);

it.effect("restores availability after a definitely pre-creation failure", () =>
  Effect.gen(function* releaseAttemptTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* failingAttempt() {
          yield* bootstrapToken.claim(ZERO_TOKEN);
          return yield* Effect.fail("pre-creation-failure");
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(yield* bootstrapToken.claim(ZERO_TOKEN)).toBeDefined();
  }),
);

it.effect("closes setup when commit-capable work leaves its attempt scope", () =>
  Effect.gen(function* unresolvedCommitTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    yield* Effect.scoped(
      Effect.gen(function* commitCapableAttempt() {
        const attempt = yield* bootstrapToken.claim(ZERO_TOKEN);
        yield* attempt.enterCommitCapable;
      }),
    );
    const closed = yield* failed(bootstrapToken.claim(ZERO_TOKEN));

    expect(closed).toMatchObject({ _tag: "BootstrapSetupClosedError" });
  }),
);

it.effect("disables the token immediately after a successful attempt", () =>
  Effect.gen(function* successfulAttemptTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    const attempt = yield* bootstrapToken.claim(ZERO_TOKEN);
    yield* attempt.enterCommitCapable;
    yield* attempt.succeed;
    const closed = yield* failed(bootstrapToken.claim(ZERO_TOKEN));

    expect(closed).toMatchObject({ _tag: "BootstrapSetupClosedError" });
  }),
);

it.effect("normalizes random generation failure without emitting a token", () =>
  Effect.gen(function* randomFailureTest() {
    const lines: string[] = [];
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => {
        throw new Error("raw-random-failure");
      },
      writeLine: captureOutput(lines),
    });

    const error = yield* failed(bootstrapToken.activate);

    expect(error).toMatchObject({ _tag: "BootstrapTokenInitializationError" });
    expect(JSON.stringify(error)?.includes("raw-random-failure") ?? false).toBe(false);
    expect(lines).toEqual([]);
  }),
);

it.effect("rejects a random source that does not return exactly 32 bytes", () =>
  Effect.gen(function* randomLengthTest() {
    const lines: string[] = [];
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES - ONE),
      writeLine: captureOutput(lines),
    });

    const error = yield* failed(bootstrapToken.activate);

    expect(error).toMatchObject({ _tag: "BootstrapTokenInitializationError" });
    expect(lines).toEqual([]);
  }),
);

it.effect("normalizes raw output failure without retaining an available token", () =>
  Effect.gen(function* outputFailureTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: () => {
        throw new Error("raw-output-failure");
      },
    });

    const error = yield* failed(bootstrapToken.activate);
    const unavailable = yield* failed(bootstrapToken.claim("candidate"));

    expect(error).toMatchObject({ _tag: "BootstrapTokenInitializationError" });
    expect(JSON.stringify(error)?.includes("raw-output-failure") ?? false).toBe(false);
    expect(unavailable).toMatchObject({ _tag: "BootstrapTokenUnavailableError" });
  }),
);

it.effect("fails closed after a partial raw token write", () =>
  Effect.gen(function* partialOutputFailureTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: (line) => line.length - ONE,
    });

    const error = yield* failed(bootstrapToken.activate);
    const unavailable = yield* failed(bootstrapToken.claim("candidate"));

    expect(error).toMatchObject({ _tag: "BootstrapTokenInitializationError" });
    expect(unavailable).toMatchObject({ _tag: "BootstrapTokenUnavailableError" });
  }),
);

it.effect("safely rejects malformed candidate lengths without consuming the token", () =>
  Effect.gen(function* malformedCandidateTest() {
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => Buffer.alloc(TOKEN_BYTES),
      writeLine: discardOutput,
    });

    yield* bootstrapToken.activate;
    for (const candidate of ["", "x".repeat(MALFORMED_CANDIDATE_LENGTH)]) {
      const invalid = yield* failed(bootstrapToken.claim(candidate));
      expect(invalid).toMatchObject({ _tag: "BootstrapTokenInvalidError" });
    }

    expect(yield* bootstrapToken.claim(ZERO_TOKEN)).toBeDefined();
  }),
);

it.effect("rejects claims from a configured process", () =>
  Effect.gen(function* configuredClaimTest() {
    const bootstrapToken = makeBootstrapToken("configured");
    const closed = yield* failed(bootstrapToken.claim("candidate"));

    expect(closed).toMatchObject({ _tag: "BootstrapSetupClosedError" });
  }),
);

it.effect("does not retry activation after raw output failure", () =>
  Effect.gen(function* activationFailureOneShotTest() {
    let randomCalls = ZERO;
    let writeCalls = ZERO;
    const bootstrapToken = makeBootstrapToken("setup-eligible", {
      randomBytes: () => {
        randomCalls += ONE;
        return Buffer.alloc(TOKEN_BYTES);
      },
      writeLine: () => {
        writeCalls += ONE;
        throw new Error("raw-output-failure");
      },
    });

    yield* failed(bootstrapToken.activate);
    yield* bootstrapToken.activate;

    expect(randomCalls).toBe(ONE);
    expect(writeCalls).toBe(ONE);
  }),
);
