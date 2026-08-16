import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";
import { writeSync } from "node:fs";

import { Context, Data, Effect, Layer } from "effect";
import type { Scope } from "effect";

import { Database } from "../database/database.ts";
import type { DatabaseInitialization } from "../database/initialization.ts";

const TOKEN_BYTES = 32;
const ZERO_BYTE = 0;

interface BootstrapAttempt {
  readonly enterCommitCapable: Effect.Effect<void>;
  readonly succeed: Effect.Effect<void>;
}

interface AttemptState {
  commitCapable: boolean;
}

interface BootstrapTokenCell {
  activationStarted: boolean;
  state: BootstrapState;
}

interface BootstrapTokenDependencies {
  readonly randomBytes: () => Buffer;
  readonly writeLine: (line: string) => number;
}

interface BootstrapTokenOptions {
  readonly randomBytes?: () => Buffer;
  readonly writeLine?: (line: string) => number;
}

type BootstrapState =
  | { readonly state: "inactive" }
  | { readonly state: "pending" }
  | { readonly digest: Buffer; readonly state: "available" }
  | { readonly attempt: AttemptState; readonly digest: Buffer; readonly state: "attempting" }
  | { readonly state: "disabled" };

const taggedError = Data.TaggedError;
const contextService = Context.Service;
const BootstrapTokenInvalidError = taggedError("BootstrapTokenInvalidError");
const BootstrapTokenUnavailableError = taggedError("BootstrapTokenUnavailableError");
const BootstrapTokenBusyError = taggedError("BootstrapTokenBusyError");
const BootstrapSetupClosedError = taggedError("BootstrapSetupClosedError");
const BootstrapTokenInitializationError = taggedError("BootstrapTokenInitializationError");

type BootstrapTokenInitializationFailure = Readonly<{
  readonly ["_tag"]: "BootstrapTokenInitializationError";
}>;
type BootstrapTokenClaimError =
  | Readonly<{ readonly ["_tag"]: "BootstrapSetupClosedError" }>
  | Readonly<{ readonly ["_tag"]: "BootstrapTokenBusyError" }>
  | Readonly<{ readonly ["_tag"]: "BootstrapTokenInvalidError" }>
  | Readonly<{ readonly ["_tag"]: "BootstrapTokenUnavailableError" }>;

interface BootstrapTokenService {
  readonly activate: Effect.Effect<void, BootstrapTokenInitializationFailure>;
  readonly claim: (
    candidate: string,
  ) => Effect.Effect<BootstrapAttempt, BootstrapTokenClaimError, Scope.Scope>;
}

const digestToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();

const wipe = (buffer: Buffer): void => {
  buffer.fill(ZERO_BYTE);
};

const candidatesMatch = (candidate: string, expected: Buffer): boolean => {
  const candidateDigest = digestToken(candidate);
  try {
    return timingSafeEqual(candidateDigest, expected);
  } finally {
    wipe(candidateDigest);
  }
};

const initialBootstrapState = (initialization: DatabaseInitialization): BootstrapState => {
  if (initialization === "configured") {
    return { state: "inactive" };
  }
  return { state: "pending" };
};

const writeRawBootstrapLine = (line: string): number => {
  const output = Buffer.from(line, "utf8");
  try {
    return writeSync(process.stdout.fd, output);
  } finally {
    wipe(output);
  }
};

const writeBootstrapLine = (line: string, writeLine: (line: string) => number): void => {
  if (writeLine(line) !== Buffer.byteLength(line)) {
    throw new Error("incomplete bootstrap token output");
  }
};

const digestAndWriteToken = (bytes: Buffer, writeLine: (line: string) => number): Buffer => {
  if (bytes.length !== TOKEN_BYTES) {
    throw new TypeError("expected exactly 32 random bytes");
  }
  const token = bytes.toString("base64url");
  const digest = digestToken(token);
  try {
    writeBootstrapLine(`NAMA_BOOTSTRAP_TOKEN=${token}\n`, writeLine);
    return digest;
  } catch (error) {
    wipe(digest);
    throw error;
  }
};

const activateToken = (randomBytes: () => Buffer, writeLine: (line: string) => number): Buffer => {
  const bytes = randomBytes();
  try {
    return digestAndWriteToken(bytes, writeLine);
  } finally {
    wipe(bytes);
  }
};

const disableAttempt = (cell: BootstrapTokenCell, attempt: AttemptState): void => {
  if (cell.state.state === "attempting" && cell.state.attempt === attempt) {
    wipe(cell.state.digest);
    cell.state = { state: "disabled" };
  }
};

const releaseAttempt = (cell: BootstrapTokenCell, attempt: AttemptState) =>
  Effect.sync(() => {
    if (cell.state.state !== "attempting" || cell.state.attempt !== attempt) {
      return;
    }
    if (attempt.commitCapable) {
      disableAttempt(cell, attempt);
      return;
    }
    cell.state = { digest: cell.state.digest, state: "available" };
  });

const makeAttempt = (cell: BootstrapTokenCell, digest: Buffer) => {
  const attemptState: AttemptState = { commitCapable: false };
  const attempt: BootstrapAttempt = {
    enterCommitCapable: Effect.sync(() => {
      if (cell.state.state === "attempting" && cell.state.attempt === attemptState) {
        attemptState.commitCapable = true;
      }
    }),
    succeed: Effect.sync(() => {
      disableAttempt(cell, attemptState);
    }),
  };
  cell.state = { attempt: attemptState, digest, state: "attempting" };
  return Effect.acquireRelease(Effect.succeed(attempt), () => releaseAttempt(cell, attemptState));
};

const claimAttempt = (
  cell: BootstrapTokenCell,
  candidate: string,
): Effect.Effect<BootstrapAttempt, BootstrapTokenClaimError, Scope.Scope> => {
  const { state } = cell;
  switch (state.state) {
    case "pending": {
      return Effect.fail(new BootstrapTokenUnavailableError(undefined));
    }
    case "attempting": {
      return Effect.fail(new BootstrapTokenBusyError(undefined));
    }
    case "inactive":
    case "disabled": {
      return Effect.fail(new BootstrapSetupClosedError(undefined));
    }
    case "available": {
      if (!candidatesMatch(candidate, state.digest)) {
        return Effect.fail(new BootstrapTokenInvalidError(undefined));
      }
      return makeAttempt(cell, state.digest);
    }
    default: {
      return Effect.fail(new BootstrapSetupClosedError(undefined));
    }
  }
};

const makeBootstrapToken = (
  initialization: DatabaseInitialization,
  options: BootstrapTokenOptions = {},
): BootstrapTokenService => {
  const dependencies: BootstrapTokenDependencies = {
    randomBytes: options.randomBytes ?? (() => nodeRandomBytes(TOKEN_BYTES)),
    writeLine: options.writeLine ?? writeRawBootstrapLine,
  };
  const cell: BootstrapTokenCell = {
    activationStarted: false,
    state: initialBootstrapState(initialization),
  };
  const activate = Effect.try({
    catch: () => new BootstrapTokenInitializationError(undefined),
    try: () => {
      if (cell.state.state !== "pending" || cell.activationStarted) {
        return;
      }
      cell.activationStarted = true;
      cell.state = {
        digest: activateToken(dependencies.randomBytes, dependencies.writeLine),
        state: "available",
      };
    },
  });
  return {
    activate,
    claim: (candidate) =>
      Effect.uninterruptible(
        Effect.suspend<BootstrapAttempt, BootstrapTokenClaimError, Scope.Scope>(() =>
          claimAttempt(cell, candidate),
        ),
      ),
  };
};

class BootstrapToken extends contextService<BootstrapToken, BootstrapTokenService>()(
  "@nama/server/BootstrapToken",
) {
  static readonly layer = () =>
    Layer.effect(
      BootstrapToken,
      Database.pipe(
        Effect.map((database) => BootstrapToken.of(makeBootstrapToken(database.initialization))),
      ),
    );
}

export { BootstrapToken, makeBootstrapToken };
export type {
  BootstrapAttempt,
  BootstrapTokenClaimError,
  BootstrapTokenInitializationFailure,
  BootstrapTokenOptions,
  BootstrapTokenService,
};
