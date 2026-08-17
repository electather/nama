import { hkdf } from "node:crypto";
import { promisify } from "node:util";

import { Effect, Redacted } from "effect";

import type { ConfigService } from "../config/schema.ts";
import {
  callRuntime,
  invokeRuntimeFunction,
  isObjectValue,
  readProperty,
  readRuntimeFunction,
  readRuntimeModule,
} from "./better-auth-adapter-runtime.ts";
import type { RuntimeModuleLoader } from "./better-auth-adapter-runtime.ts";

const BASE64_MASTER_KEY_PREFIX = "base64:";
const EMPTY_STRING_LENGTH = 0;
const HKDF_HASH = "sha256";
const HKDF_INFO = "nama/better-auth/v1";
const HKDF_OUTPUT_BYTES = 32;
const INVALID_EMAIL_OR_PASSWORD = "INVALID_EMAIL_OR_PASSWORD";
const SIGNED_BEARER_PATTERN = /^[A-Za-z0-9]{32}\.[A-Za-z0-9+/]{43}=$/u;
const secretDerivationFailure = Symbol("secret derivation failure");

type InvalidCredentials = Readonly<{ readonly _tag: "InvalidCredentials" }>;
type InvalidBearer = Readonly<{ readonly _tag: "InvalidBearer" }>;
type AuthenticationStoreUnavailable = Readonly<{
  readonly _tag: "AuthenticationStoreUnavailable";
}>;
type PrivateAuthenticationDefect = Readonly<{ readonly _tag: "PrivateAuthenticationDefect" }>;
type StoreFailure = AuthenticationStoreUnavailable | PrivateAuthenticationDefect;
type ResolveBearerFailure = StoreFailure | InvalidBearer;

interface Administrator {
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
}

interface ResolvedBearer {
  readonly administrator: Administrator;
  readonly sessionExpiresAt: Date;
}

interface RuntimeResultOptions<Result> {
  readonly defect: PrivateAuthenticationDefect;
  readonly parse: (value: unknown) => Result | undefined;
  readonly result: unknown;
}

interface SecretMaterial {
  readonly info: Buffer;
  readonly masterKey: Buffer;
  readonly salt: Buffer;
}

const invalidCredentials: InvalidCredentials = Object.freeze({ _tag: "InvalidCredentials" });
const invalidBearer: InvalidBearer = Object.freeze({ _tag: "InvalidBearer" });
const authenticationStoreUnavailable: AuthenticationStoreUnavailable = Object.freeze({
  _tag: "AuthenticationStoreUnavailable",
});
const privateAuthenticationDefect: PrivateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect",
});

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > EMPTY_STRING_LENGTH;

const readSessionExpiry = (value: unknown): Date | undefined => {
  if (!isObjectValue(value)) {
    return undefined;
  }
  const expiresAt = readProperty(value, "expiresAt");
  if (!(expiresAt instanceof Date)) {
    return undefined;
  }
  const timestamp = expiresAt.getTime();
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp);
};

const toAdministrator = (value: unknown): Administrator | undefined => {
  if (!isObjectValue(value)) {
    return undefined;
  }
  const id = readProperty(value, "id");
  const displayName = readProperty(value, "name");
  const email = readProperty(value, "email");
  if (!isNonEmptyString(id) || !isNonEmptyString(displayName) || !isNonEmptyString(email)) {
    return undefined;
  }
  return Object.freeze({ displayName, email: email.toLowerCase(), id });
};

const readSignInHeaders = (value: object): Headers | undefined => {
  const response = readProperty(value, "response");
  if (!isObjectValue(response)) {
    return undefined;
  }
  const headers = readProperty(value, "headers");
  if (!(headers instanceof Headers)) {
    return undefined;
  }
  return headers;
};

const readSignedBearer = (value: unknown): string | undefined => {
  if (!isObjectValue(value)) {
    return undefined;
  }
  const headers = readSignInHeaders(value);
  if (headers === undefined) {
    return undefined;
  }
  const bearer = headers.get("set-auth-token");
  if (bearer === null || !SIGNED_BEARER_PATTERN.test(bearer)) {
    return undefined;
  }
  return bearer;
};

const isInvalidCredentialsError = (value: unknown): boolean => {
  try {
    if (!isObjectValue(value)) {
      return false;
    }
    const body = readProperty(value, "body");
    return isObjectValue(body) && readProperty(body, "code") === INVALID_EMAIL_OR_PASSWORD;
  } catch {
    return false;
  }
};

const parseRuntimeResult = <Result>({
  defect,
  parse,
  result,
}: RuntimeResultOptions<Result>): Effect.Effect<Result, PrivateAuthenticationDefect> =>
  Effect.try<Result | undefined, PrivateAuthenticationDefect>({
    catch: () => defect,
    try: () => parse(result),
  }).pipe(
    Effect.flatMap((parsed): Effect.Effect<Result, PrivateAuthenticationDefect> => {
      if (parsed === undefined) {
        return Effect.fail(defect);
      }
      return Effect.succeed(parsed);
    }),
  );

const parseCreateAdministratorResult = (value: unknown): Administrator | undefined => {
  if (!isObjectValue(value) || readProperty(value, "token") !== null) {
    return undefined;
  }
  return toAdministrator(readProperty(value, "user"));
};

const parseResolvedBearer = (value: unknown): ResolvedBearer | undefined => {
  if (!isObjectValue(value)) {
    return undefined;
  }
  const sessionExpiresAt = readSessionExpiry(readProperty(value, "session"));
  const administrator = toAdministrator(readProperty(value, "user"));
  if (sessionExpiresAt === undefined || administrator === undefined) {
    return undefined;
  }
  return Object.freeze({ administrator, sessionExpiresAt });
};

const authorizationHeaders = (authorization: string): Headers =>
  new Headers([["authorization", authorization]]);

const makeResolveBearer =
  (runtime: unknown) =>
  (authorization: string): Effect.Effect<ResolvedBearer, ResolveBearerFailure> =>
    callRuntime({
      defect: privateAuthenticationDefect,
      input: {
        headers: authorizationHeaders(authorization),
        query: { disableCookieCache: true, disableRefresh: true },
      },
      methodName: "getSession",
      onRejection: () => authenticationStoreUnavailable,
      runtime,
    }).pipe(
      Effect.flatMap((result): Effect.Effect<ResolvedBearer, ResolveBearerFailure> => {
        if (result === null) {
          return Effect.fail(invalidBearer);
        }
        return parseRuntimeResult({
          defect: privateAuthenticationDefect,
          parse: parseResolvedBearer,
          result,
        });
      }),
    );

const makeSignOut =
  (runtime: unknown) =>
  (authorization: string): Effect.Effect<void, StoreFailure> =>
    callRuntime({
      defect: privateAuthenticationDefect,
      input: { headers: authorizationHeaders(authorization) },
      methodName: "signOut",
      onRejection: () => authenticationStoreUnavailable,
      runtime,
    }).pipe(Effect.asVoid);

const decodeSecretMaterial = (
  masterKey: ConfigService["security"]["masterKey"],
): SecretMaterial => {
  const encodedMasterKey = Redacted.value(masterKey);
  return {
    info: Buffer.from(HKDF_INFO, "utf8"),
    masterKey: Buffer.from(encodedMasterKey.slice(BASE64_MASTER_KEY_PREFIX.length), "base64"),
    salt: Buffer.alloc(EMPTY_STRING_LENGTH),
  };
};

const wipeSecretMaterial = (material: SecretMaterial): void => {
  material.info.fill(EMPTY_STRING_LENGTH);
  material.masterKey.fill(EMPTY_STRING_LENGTH);
  material.salt.fill(EMPTY_STRING_LENGTH);
};

const deriveHkdfOutput = promisify(hkdf);

const deriveSecret = (
  masterKey: ConfigService["security"]["masterKey"],
): Effect.Effect<string, typeof secretDerivationFailure> =>
  Effect.tryPromise({
    catch: () => secretDerivationFailure,
    try: async () => {
      const material = decodeSecretMaterial(masterKey);
      try {
        const output = Buffer.from(
          await deriveHkdfOutput(
            HKDF_HASH,
            material.masterKey,
            material.salt,
            material.info,
            HKDF_OUTPUT_BYTES,
          ),
        );
        try {
          return output.toString("base64url");
        } finally {
          output.fill(EMPTY_STRING_LENGTH);
        }
      } finally {
        wipeSecretMaterial(material);
      }
    },
  });

export {
  authenticationStoreUnavailable,
  callRuntime,
  deriveSecret,
  makeResolveBearer,
  makeSignOut,
  invalidCredentials,
  invokeRuntimeFunction,
  isInvalidCredentialsError,
  parseCreateAdministratorResult,
  parseRuntimeResult,
  privateAuthenticationDefect,
  readRuntimeFunction,
  readRuntimeModule,
  readSignedBearer,
};
export type {
  Administrator,
  AuthenticationStoreUnavailable,
  InvalidBearer,
  InvalidCredentials,
  PrivateAuthenticationDefect,
  ResolveBearerFailure,
  ResolvedBearer,
  RuntimeModuleLoader,
  RuntimeResultOptions,
  StoreFailure,
};
