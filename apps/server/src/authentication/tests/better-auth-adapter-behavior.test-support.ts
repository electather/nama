import { expect } from "@effect/vitest";
import { Redacted } from "effect";

import type { ConfigService } from "../../config/schema.ts";
import { makeBetterAuthAdapter } from "../better-auth-adapter.ts";
import type {
  BetterAuthModule,
  BetterAuthModuleLoader as BehaviorModuleLoader,
} from "./better-auth-adapter-construction.test-support.ts";

const ABSENT_PARAMETER = "absent";
const BETTER_AUTH_ABSENT = new URLSearchParams().get(ABSENT_PARAMETER);
const AUTHORIZATION_HEADER = "authorization";
const AUTHORIZATION_SCHEME = "Bearer";
const DATABASE_URL = "postgres://nama:database-private-value@127.0.0.1:5432/nama";
const EMPTY_STRING = "";
const FIRST_CALL = 0;
const INVALID_CREDENTIAL_STATUS = "UNAUTHORIZED";
const INVALID_CREDENTIAL_STATUS_CODE = 401;
const INVALID_DATE_TEXT = "invalid";
const INVALID_NUMBER = 1;
const MASTER_KEY_BYTE = 7;
const MASTER_KEY_BYTES = 32;
const MAX_CONNECTIONS = 1;
const ONE_CALL = 1;
const PUBLIC_URL = "https://public.nama.example/";
const SET_AUTH_TOKEN_HEADER = "set-auth-token";
const SIGNED_BEARER =
  "abcdefghijklmnopqrstuvwxyzABCDEF.47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
const ADMINISTRATOR_ID = "administrator-1";
const DISPLAY_NAME = "Ada Administrator";
const EMAIL = "ada.administrator@nama.example";
const PASSWORD = "correct-horse-battery-staple";
const RUNTIME_EMAIL = "ADA.ADMINISTRATOR@NAMA.EXAMPLE";
const SESSION_EXPIRY = new Date("2026-09-01T12:00:00.000Z");
const AUTHORIZATION = `${AUTHORIZATION_SCHEME} ${SIGNED_BEARER}`;
const PRIVATE_COOKIE = "better-auth.session_token=private-cookie-token";
const PRIVATE_ERROR_MESSAGE = "private Better Auth runtime failure";
const PRIVATE_HEADER_VALUE = "private-header-value";
const PRIVATE_PROPERTY = "private-runtime-property";
const PRIVATE_PROPERTY_VALUE = "private runtime detail";
const PRIVATE_RESPONSE_TOKEN = "private-response-session-token";
const PRIVATE_SESSION_TOKEN = "private-session-token";
const MASTER_KEY = Buffer.alloc(MASTER_KEY_BYTES, MASTER_KEY_BYTE);
const MASTER_KEY_BASE64 = MASTER_KEY.toString("base64");
const expectedAdministrator = Object.freeze({
  displayName: DISPLAY_NAME,
  email: EMAIL,
  id: ADMINISTRATOR_ID,
});
const expectedResolvedBearer = Object.freeze({
  administrator: expectedAdministrator,
  sessionExpiresAt: SESSION_EXPIRY,
});
const expectedSignIn = Object.freeze({
  ...expectedResolvedBearer,
  bearer: SIGNED_BEARER,
});
const database = Object.freeze({ testDatabase: true });
const databaseService = Object.freeze({
  authentication: Object.freeze({ database }),
});
const configuration = Object.freeze({
  database: Object.freeze({
    maxConnections: MAX_CONNECTIONS,
    url: Redacted.make(DATABASE_URL),
  }),
  logging: Object.freeze({ level: "error" }),
  security: Object.freeze({
    masterKey: Redacted.make(`base64:${MASTER_KEY_BASE64}`),
  }),
  server: Object.freeze({ bind: "127.0.0.1:8080", publicUrl: PUBLIC_URL }),
}) satisfies ConfigService;
type FailureTag =
  | "AuthenticationStoreUnavailable"
  | "InvalidBearer"
  | "InvalidCredentials"
  | "PrivateAuthenticationDefect";
type RuntimeMethod = "getSession" | "signInEmail" | "signOut" | "signUpEmail";
type RuntimeRecord = Record<string, unknown>;
type RuntimeResult = RuntimeRecord | typeof BETTER_AUTH_ABSENT | undefined;
type RuntimePlans = Record<RuntimeMethod, () => Promise<unknown>>;
type BehaviorRuntimeCaptures = Readonly<Record<RuntimeMethod, unknown[]>>;
interface BehaviorRuntimeFakes {
  readonly captures: BehaviorRuntimeCaptures;
  readonly loadModule: BehaviorModuleLoader;
  readonly plans: RuntimePlans;
}
const resolvedPlan =
  (result: unknown): (() => Promise<unknown>) =>
  () =>
    Promise.resolve(result);
const rejectPromise: (reason?: unknown) => Promise<never> = Promise.reject.bind(Promise);
const rejectedPlan = (error: Error): (() => Promise<never>) => rejectPromise.bind(undefined, error);
const makeRuntimeUser = (): RuntimeRecord => ({
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  email: RUNTIME_EMAIL,
  emailVerified: true,
  id: ADMINISTRATOR_ID,
  image: BETTER_AUTH_ABSENT,
  name: DISPLAY_NAME,
  privateUserField: PRIVATE_PROPERTY_VALUE,
  updatedAt: new Date("2026-08-02T12:00:00.000Z"),
});
const makeRuntimeSession = (): RuntimeRecord => ({
  createdAt: new Date("2026-08-03T12:00:00.000Z"),
  expiresAt: SESSION_EXPIRY,
  id: "session-1",
  ipAddress: "127.0.0.1",
  privateSessionField: PRIVATE_PROPERTY_VALUE,
  token: PRIVATE_SESSION_TOKEN,
  updatedAt: new Date("2026-08-04T12:00:00.000Z"),
  userAgent: "private user agent",
  userId: ADMINISTRATOR_ID,
});
const makeSignUpResponse = (): RuntimeRecord => ({
  privateTopLevelField: PRIVATE_PROPERTY_VALUE,
  token: BETTER_AUTH_ABSENT,
  user: makeRuntimeUser(),
});
const makeSignInResponse = (): RuntimeRecord => ({
  headers: new Headers([
    [SET_AUTH_TOKEN_HEADER, SIGNED_BEARER],
    ["set-cookie", PRIVATE_COOKIE],
    ["x-private-response-header", PRIVATE_HEADER_VALUE],
  ]),
  response: {
    privateResponseField: PRIVATE_PROPERTY_VALUE,
    redirect: false,
    token: PRIVATE_RESPONSE_TOKEN,
    url: undefined,
    user: makeRuntimeUser(),
  },
});
const makeSessionResponse = (): RuntimeRecord => ({
  privateTopLevelField: PRIVATE_PROPERTY_VALUE,
  session: makeRuntimeSession(),
  user: makeRuntimeUser(),
});
const makeBehaviorRuntimeFakes = (): BehaviorRuntimeFakes => {
  const captures: BehaviorRuntimeCaptures = {
    getSession: [],
    signInEmail: [],
    signOut: [],
    signUpEmail: [],
  };
  const plans: RuntimePlans = {
    getSession: resolvedPlan(makeSessionResponse()),
    signInEmail: resolvedPlan(makeSignInResponse()),
    signOut: resolvedPlan({ privateResponseField: PRIVATE_PROPERTY_VALUE, success: true }),
    signUpEmail: resolvedPlan(makeSignUpResponse()),
  };
  const invoke = (method: RuntimeMethod, input: unknown): Promise<unknown> => {
    captures[method].push(input);
    return plans[method]();
  };
  const api = Object.freeze({
    getSession: (input: unknown) => invoke("getSession", input),
    signInEmail: (input: unknown) => invoke("signInEmail", input),
    signOut: (input: unknown) => invoke("signOut", input),
    signUpEmail: (input: unknown) => invoke("signUpEmail", input),
  });
  const modules: Record<string, BetterAuthModule> = {
    "better-auth": { betterAuth: () => Object.freeze({ api }) },
    "better-auth/adapters/drizzle": { drizzleAdapter: () => Object.freeze({ adapter: "drizzle" }) },
    "better-auth/plugins/bearer": { bearer: () => Object.freeze({ id: "bearer" }) },
  };
  const loadModule: BehaviorModuleLoader = (moduleId) => {
    const module = modules[moduleId];
    if (module === undefined) {
      throw new Error(`unexpected Better Auth module ${moduleId}`);
    }
    return module;
  };
  return { captures, loadModule, plans };
};
const makeAdapter = (fakes: BehaviorRuntimeFakes) =>
  makeBetterAuthAdapter({
    config: configuration,
    database: databaseService,
    loadModule: fakes.loadModule,
  });
const expectObject = (value: unknown, description: string): object => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value;
};
const expectKeys = (value: object, keys: readonly string[]): void => {
  expect(Object.keys(value).toSorted()).toStrictEqual(keys.toSorted());
};
const expectAuthorizationHeaders = (value: unknown): void => {
  const headers: unknown = Reflect.get(expectObject(value, "Better Auth call"), "headers");
  if (!(headers instanceof Headers)) {
    throw new TypeError("Better Auth call headers must be Headers");
  }
  expect([...headers.entries()]).toStrictEqual([[AUTHORIZATION_HEADER, AUTHORIZATION]]);
};
const expectCreateAdministratorCall = (value: unknown): void => {
  const call = expectObject(value, "signUpEmail call");
  const body: unknown = Reflect.get(call, "body");
  expectKeys(call, ["body"]);
  expectKeys(expectObject(body, "signUpEmail body"), ["email", "name", "password"]);
  expect(body).toStrictEqual({ email: EMAIL, name: DISPLAY_NAME, password: PASSWORD });
};
const expectSignInCall = (value: unknown): void => {
  const call = expectObject(value, "signInEmail call");
  const body: unknown = Reflect.get(call, "body");
  expectKeys(call, ["body", "returnHeaders"]);
  expect(Reflect.get(call, "returnHeaders")).toBe(true);
  expectKeys(expectObject(body, "signInEmail body"), ["email", "password"]);
  expect(body).toStrictEqual({ email: EMAIL, password: PASSWORD });
};
const expectResolveBearerCall = (value: unknown): void => {
  const call = expectObject(value, "getSession call");
  expectKeys(call, ["headers", "query"]);
  expectAuthorizationHeaders(call);
  expect(Reflect.get(call, "query")).toStrictEqual({
    disableCookieCache: true,
    disableRefresh: true,
  });
};
const expectSignOutCall = (value: unknown): void => {
  const call = expectObject(value, "signOut call");
  expectKeys(call, ["headers"]);
  expectAuthorizationHeaders(call);
};
const privateValues = [
  PRIVATE_COOKIE,
  PRIVATE_ERROR_MESSAGE,
  PRIVATE_HEADER_VALUE,
  PRIVATE_PROPERTY,
  PRIVATE_PROPERTY_VALUE,
  PRIVATE_RESPONSE_TOKEN,
  PRIVATE_SESSION_TOKEN,
] as const;
const expectPrivateValuesAbsent = (value: unknown): void => {
  const representation = `${String(value)}${JSON.stringify(value) ?? EMPTY_STRING}`;
  for (const privateValue of privateValues) {
    expect(representation).not.toContain(privateValue);
  }
};
const expectSafeFailure = (failure: unknown, tag: FailureTag): void => {
  expect(failure).toStrictEqual({ _tag: tag });
  expect(Reflect.ownKeys(expectObject(failure, "adapter failure"))).toStrictEqual(["_tag"]);
  expectPrivateValuesAbsent(failure);
};
const makeBehaviorPrivateError = (): Error =>
  Object.assign(new Error(PRIVATE_ERROR_MESSAGE), { [PRIVATE_PROPERTY]: PRIVATE_PROPERTY_VALUE });
const makeInvalidCredentialsError = (): Error =>
  Object.assign(makeBehaviorPrivateError(), {
    body: { code: "INVALID_EMAIL_OR_PASSWORD", message: PRIVATE_ERROR_MESSAGE },
    headers: {},
    status: INVALID_CREDENTIAL_STATUS,
    statusCode: INVALID_CREDENTIAL_STATUS_CODE,
  });
// fallow-ignore-next-line code-duplication -- Independent explicit test-fixture export surface.
export {
  AUTHORIZATION,
  BETTER_AUTH_ABSENT,
  DISPLAY_NAME,
  EMAIL,
  EMPTY_STRING,
  FIRST_CALL,
  INVALID_DATE_TEXT,
  INVALID_NUMBER,
  ONE_CALL,
  PASSWORD,
  PRIVATE_COOKIE,
  PRIVATE_RESPONSE_TOKEN,
  SET_AUTH_TOKEN_HEADER,
  SIGNED_BEARER,
  expectedAdministrator,
  expectedResolvedBearer,
  expectedSignIn,
  expectCreateAdministratorCall,
  expectPrivateValuesAbsent,
  expectResolveBearerCall,
  expectSafeFailure,
  expectSignInCall,
  expectSignOutCall,
  makeAdapter,
  makeInvalidCredentialsError,
  makeBehaviorPrivateError,
  makeBehaviorRuntimeFakes,
  makeRuntimeSession,
  makeRuntimeUser,
  makeSignInResponse,
  rejectedPlan,
  resolvedPlan,
  type BehaviorModuleLoader,
  type BehaviorRuntimeCaptures,
  type BehaviorRuntimeFakes,
  type FailureTag,
  type RuntimeMethod,
  type RuntimePlans,
  type RuntimeRecord,
  type RuntimeResult,
};
