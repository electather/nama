import { hkdf as nodeHkdf } from "node:crypto";
import { promisify } from "node:util";

import { expect } from "@effect/vitest";
import { Redacted } from "effect";

import type { ConfigService } from "../../config/schema.ts";
import { account, session, user, verification } from "../../database/auth-schema.ts";
import type { RuntimeModuleLoader as BetterAuthModuleLoader } from "../better-auth-adapter-runtime.ts";

const hkdf = promisify(nodeHkdf);
const HKDF_HASH = "sha256";
const HKDF_INFO = "nama/better-auth/v1";
const HKDF_OUTPUT_BYTES = 32;
const ZERO = 0;
const UNPADDED_SECRET_LENGTH = 43;
const BASE64_PREFIX = "base64:";
const PUBLIC_URL = "https://public.nama.example/";
const DATABASE_URL = "postgres://nama:database-private-value@127.0.0.1:5432/nama";
const PRIVATE_ERROR_MESSAGE = "private Better Auth runtime failure";
const PRIVATE_PROPERTY = "private-runtime-property";
const PRIVATE_PROPERTY_VALUE = "private runtime detail";
const TEST_DATABASE_MAX_CONNECTIONS = 1;
const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 128;
const MASTER_KEY_BYTE = 7;
const DIFFERENT_MASTER_KEY_BYTE = 8;
const EXPECTED_MODULE_IDS = [
  "better-auth",
  "better-auth/adapters/drizzle",
  "better-auth/plugins/bearer",
];
const EMPTY_HKDF_SALT = Buffer.alloc(ZERO);
const HKDF_INFO_BYTES = Buffer.from(HKDF_INFO, "utf8");
const UNPADDED_BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MASTER_KEY = Buffer.alloc(HKDF_OUTPUT_BYTES, MASTER_KEY_BYTE);
const DIFFERENT_MASTER_KEY = Buffer.alloc(HKDF_OUTPUT_BYTES, DIFFERENT_MASTER_KEY_BYTE);
const DATABASE = Object.freeze({ testDatabase: true });
const DATABASE_SERVICE = Object.freeze({
  authentication: Object.freeze({ database: DATABASE }),
});
const GENERATED_AUTH_SCHEMA = {
  account,
  session,
  user,
  verification,
} satisfies GeneratedAuthSchema;
type BetterAuthModule = Record<string, unknown>;
type RuntimeOptions = BetterAuthModule;
interface GeneratedAuthSchema {
  readonly account: unknown;
  readonly session: unknown;
  readonly user: unknown;
  readonly verification: unknown;
}
type DrizzleAdapterCall = Readonly<{ configuration: RuntimeOptions; database: unknown }>;
interface RuntimeCaptures {
  readonly bearerOptions: (RuntimeOptions | undefined)[];
  readonly betterAuthOptions: RuntimeOptions[];
  readonly drizzleAdapterCalls: DrizzleAdapterCall[];
  readonly forbiddenCalls: string[];
  readonly moduleIds: string[];
}
interface RuntimeFakes {
  readonly adapter: unknown;
  readonly captures: RuntimeCaptures;
  readonly loadModule: BetterAuthModuleLoader;
  readonly modules: Record<string, BetterAuthModule>;
  readonly plugin: unknown;
}
const encodeMasterKey = (masterKey: Buffer): string =>
  `${BASE64_PREFIX}${masterKey.toString("base64")}`;
const makeConfiguration = (masterKey: Buffer = MASTER_KEY) => {
  const encodedMasterKey = encodeMasterKey(masterKey);
  const redactedMasterKey = Redacted.make(encodedMasterKey);
  const security = Object.freeze({ masterKey: redactedMasterKey });
  return Object.freeze({
    database: Object.freeze({
      maxConnections: TEST_DATABASE_MAX_CONNECTIONS,
      url: Redacted.make(DATABASE_URL),
    }),
    logging: Object.freeze({ level: "error" }),
    security,
    server: Object.freeze({ bind: "127.0.0.1:8080", lanDiscovery: false, publicUrl: PUBLIC_URL }),
  }) satisfies ConfigService;
};
const makeInput = (loadModule: BetterAuthModuleLoader, masterKey: Buffer = MASTER_KEY) => ({
  config: makeConfiguration(masterKey),
  database: DATABASE_SERVICE,
  loadModule,
});
const expectedSecret = async (masterKey: Buffer): Promise<string> => {
  const derived = await hkdf(
    HKDF_HASH,
    masterKey,
    EMPTY_HKDF_SALT,
    HKDF_INFO_BYTES,
    HKDF_OUTPUT_BYTES,
  );
  return Buffer.from(derived).toString("base64url");
};
const makeForbiddenExport = (captures: RuntimeCaptures, name: string) => () => {
  captures.forbiddenCalls.push(name);
  throw new TypeError(`${name} must not run during adapter construction`);
};
const makeRuntimeModules = (
  captures: RuntimeCaptures,
  adapter: unknown,
  plugin: unknown,
): Record<string, BetterAuthModule> => ({
  "better-auth": {
    betterAuth: (options: RuntimeOptions) => {
      captures.betterAuthOptions.push(options);
      return Object.freeze({ privateRuntime: true });
    },
    handler: makeForbiddenExport(captures, "handler"),
    migrate: makeForbiddenExport(captures, "migrate"),
  },
  "better-auth/adapters/drizzle": {
    drizzleAdapter: (database: unknown, configuration: RuntimeOptions) => {
      captures.drizzleAdapterCalls.push({ configuration, database });
      return adapter;
    },
    handler: makeForbiddenExport(captures, "adapter handler"),
    migrate: makeForbiddenExport(captures, "adapter migrate"),
  },
  "better-auth/plugins/bearer": {
    bearer: (options: RuntimeOptions | undefined) => {
      captures.bearerOptions.push(options);
      return plugin;
    },
    handler: makeForbiddenExport(captures, "bearer handler"),
    migrate: makeForbiddenExport(captures, "bearer migrate"),
  },
});
const makeRuntimeFakes = (): RuntimeFakes => {
  const captures: RuntimeCaptures = {
    bearerOptions: [],
    betterAuthOptions: [],
    drizzleAdapterCalls: [],
    forbiddenCalls: [],
    moduleIds: [],
  };
  const adapter = Object.freeze({ adapter: "drizzle" });
  const plugin = Object.freeze({ id: "bearer" });
  const modules = makeRuntimeModules(captures, adapter, plugin);
  const loadModule: BetterAuthModuleLoader = (moduleId) => {
    captures.moduleIds.push(moduleId);
    const runtimeModule = modules[moduleId];
    if (runtimeModule === undefined) {
      throw new TypeError(`unexpected Better Auth module ${moduleId}`);
    }
    return runtimeModule;
  };
  return { adapter, captures, loadModule, modules, plugin };
};
const capturedSecret = (fakes: RuntimeFakes): string => {
  const secret = fakes.captures.betterAuthOptions[ZERO]?.["secret"];
  if (typeof secret !== "string") {
    throw new TypeError("Better Auth factory did not receive a string secret");
  }
  return secret;
};
const makePrivateError = (): Error => {
  const error = new Error(PRIVATE_ERROR_MESSAGE);
  Object.defineProperty(error, PRIVATE_PROPERTY, {
    enumerable: true,
    value: PRIVATE_PROPERTY_VALUE,
  });
  return error;
};
const safeFailureRepresentation = (failure: unknown): string => {
  let representation = "";
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string"
  ) {
    representation = failure.message;
  }
  const serializedFailure = JSON.stringify(failure);
  if (typeof serializedFailure === "string") {
    representation += serializedFailure;
  }
  return representation;
};
const expectSafeConstructionFailure = (failure: unknown, privateError: Error): void => {
  expect(failure).toMatchObject({ _tag: "BetterAuthConstructionError" });
  expect(failure).not.toBe(privateError);
  expect(failure).not.toHaveProperty("cause");
  expect(failure).not.toHaveProperty(PRIVATE_PROPERTY);

  const representation = safeFailureRepresentation(failure);
  for (const privateValue of [
    PRIVATE_ERROR_MESSAGE,
    PRIVATE_PROPERTY,
    PRIVATE_PROPERTY_VALUE,
    encodeMasterKey(MASTER_KEY),
    PUBLIC_URL,
    DATABASE_URL,
  ]) {
    expect(representation).not.toContain(privateValue);
  }
};

const isGeneratedAuthSchema = (value: unknown): value is GeneratedAuthSchema =>
  typeof value === "object" &&
  value !== null &&
  "account" in value &&
  "session" in value &&
  "user" in value &&
  "verification" in value;

const expectModuleLoading = (fakes: RuntimeFakes): void => {
  expect(fakes.captures.moduleIds).toHaveLength(EXPECTED_MODULE_IDS.length);
  expect(fakes.captures.moduleIds.toSorted()).toEqual(EXPECTED_MODULE_IDS.toSorted());
};

const expectDrizzleAdapterConfiguration = (fakes: RuntimeFakes): void => {
  expect(fakes.captures.drizzleAdapterCalls).toEqual([
    {
      configuration: {
        provider: "pg",
        schema: GENERATED_AUTH_SCHEMA,
        transaction: true,
      },
      database: DATABASE,
    },
  ]);
  const [drizzleAdapterCall] = fakes.captures.drizzleAdapterCalls;
  if (drizzleAdapterCall === undefined) {
    throw new TypeError("Drizzle adapter must receive exactly one configuration");
  }
  const configuredSchema = drizzleAdapterCall.configuration["schema"];
  if (!isGeneratedAuthSchema(configuredSchema)) {
    throw new TypeError("Drizzle adapter must receive an authentication schema");
  }
  const hasExactSchemaIdentity =
    configuredSchema.account === account &&
    configuredSchema.session === session &&
    configuredSchema.user === user &&
    configuredSchema.verification === verification;
  expect(hasExactSchemaIdentity).toBe(true);
};

const expectRuntimeConfiguration = (fakes: RuntimeFakes, secret: string): void => {
  expect(fakes.captures.bearerOptions).toEqual([{ requireSignature: true }]);
  expect(fakes.captures.betterAuthOptions).toEqual([
    {
      baseURL: PUBLIC_URL,
      database: fakes.adapter,
      emailAndPassword: {
        autoSignIn: false,
        enabled: true,
        maxPasswordLength: MAXIMUM_PASSWORD_LENGTH,
        minPasswordLength: MINIMUM_PASSWORD_LENGTH,
      },
      logger: { disabled: true },
      plugins: [fakes.plugin],
      secret,
      telemetry: { enabled: false },
    },
  ]);
  expect(capturedSecret(fakes)).not.toBe(encodeMasterKey(MASTER_KEY));
  expect(fakes.captures.forbiddenCalls).toEqual([]);
};

const requireRuntimeModule = (fakes: RuntimeFakes, moduleId: string): BetterAuthModule => {
  const runtimeModule = fakes.modules[moduleId];
  if (runtimeModule === undefined) {
    throw new TypeError(`missing test runtime module ${moduleId}`);
  }
  return runtimeModule;
};

export {
  DIFFERENT_MASTER_KEY,
  HKDF_OUTPUT_BYTES,
  MASTER_KEY,
  PRIVATE_PROPERTY,
  UNPADDED_BASE64URL,
  UNPADDED_SECRET_LENGTH,
  capturedSecret,
  expectDrizzleAdapterConfiguration,
  expectModuleLoading,
  expectRuntimeConfiguration,
  expectSafeConstructionFailure,
  expectedSecret,
  makeInput,
  makePrivateError,
  makeRuntimeFakes,
  requireRuntimeModule,
  type BetterAuthModule,
  type BetterAuthModuleLoader,
  type DrizzleAdapterCall,
  type RuntimeCaptures,
  type RuntimeFakes,
  type RuntimeOptions,
};
