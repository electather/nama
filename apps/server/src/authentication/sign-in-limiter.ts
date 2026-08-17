import { createHash } from "node:crypto";

const ATTEMPT_INCREMENT = 1;
const GLOBAL_ATTEMPT_LIMIT = 100;
const GLOBAL_WINDOW_MILLISECONDS = 10_000;
const IDENTITY_ATTEMPT_LIMIT = 5;
const IDENTITY_WINDOW_MINUTES = 15;
const MILLISECONDS_PER_MINUTE = 60_000;
const IDENTITY_WINDOW_MILLISECONDS = IDENTITY_WINDOW_MINUTES * MILLISECONDS_PER_MINUTE;
const INITIAL_ATTEMPT_COUNT = 0;
const INITIAL_GLOBAL_WINDOW_START = 0;

interface IdentityWindow {
  readonly attempts: number;
  readonly startedAt: number;
}

interface SignInLimiterState {
  globalAttempts: number;
  globalStartedAt: number;
  hasGlobalWindow: boolean;
  readonly identityWindows: Map<string, IdentityWindow>;
}

interface SignInLimiter {
  readonly activeIdentityEntryCount: number;
  readonly clearIdentity: (email: string) => void;
  readonly consumeGlobal: () => number | undefined;
  readonly consumeIdentity: (email: string) => number | undefined;
}

const digestNormalizedEmail = (email: string): string =>
  createHash("sha256").update(email.toLowerCase(), "utf8").digest("hex");

const pruneExpiredIdentityWindows = (state: SignInLimiterState, currentTime: number): void => {
  for (const [digest, window] of state.identityWindows) {
    if (currentTime >= window.startedAt + IDENTITY_WINDOW_MILLISECONDS) {
      state.identityWindows.delete(digest);
    }
  }
};

const consumeGlobal = (state: SignInLimiterState, now: () => number): number | undefined => {
  const currentTime = now();

  if (!state.hasGlobalWindow || currentTime >= state.globalStartedAt + GLOBAL_WINDOW_MILLISECONDS) {
    state.globalStartedAt = currentTime;
    state.globalAttempts = INITIAL_ATTEMPT_COUNT;
    state.hasGlobalWindow = true;
  }

  if (state.globalAttempts >= GLOBAL_ATTEMPT_LIMIT) {
    return state.globalStartedAt + GLOBAL_WINDOW_MILLISECONDS - currentTime;
  }

  state.globalAttempts += ATTEMPT_INCREMENT;
  return undefined;
};

const consumeIdentity = (
  state: SignInLimiterState,
  email: string,
  now: () => number,
): number | undefined => {
  const currentTime = now();
  pruneExpiredIdentityWindows(state, currentTime);

  const digest = digestNormalizedEmail(email);
  const window = state.identityWindows.get(digest) ?? {
    attempts: INITIAL_ATTEMPT_COUNT,
    startedAt: currentTime,
  };

  if (window.attempts >= IDENTITY_ATTEMPT_LIMIT) {
    return window.startedAt + IDENTITY_WINDOW_MILLISECONDS - currentTime;
  }

  state.identityWindows.set(digest, {
    attempts: window.attempts + ATTEMPT_INCREMENT,
    startedAt: window.startedAt,
  });
  return undefined;
};

export const makeSignInLimiter = ({
  now,
}: Readonly<{ readonly now: () => number }>): SignInLimiter => {
  const state: SignInLimiterState = {
    globalAttempts: INITIAL_ATTEMPT_COUNT,
    globalStartedAt: INITIAL_GLOBAL_WINDOW_START,
    hasGlobalWindow: false,
    identityWindows: new Map<string, IdentityWindow>(),
  };

  return {
    get activeIdentityEntryCount(): number {
      return state.identityWindows.size;
    },
    clearIdentity: (email) => {
      state.identityWindows.delete(digestNormalizedEmail(email));
    },
    consumeGlobal: () => consumeGlobal(state, now),
    consumeIdentity: (email) => consumeIdentity(state, email, now),
  };
};

export type { SignInLimiter };
