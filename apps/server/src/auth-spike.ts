// oxlint-disable eslint/max-lines, eslint/max-lines-per-function, eslint/max-statements, eslint/sort-imports, import/no-nodejs-modules, promise/prefer-await-to-callbacks, typescript/no-unsafe-type-assertion, typescript/prefer-readonly-parameter-types -- This disposable Node/Connect integration keeps the entire private Better Auth boundary auditable in one file; runtime assertions isolate Better Auth declarations that do not compile under the repository's TypeScript 7 settings.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequire } from "node:module";

import { Code, ConnectError, createContextKey } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { ErrorInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";

import { contractAuthorityByMethod } from "./contract-authorization.ts";

interface AuthSpikeOptions {
  readonly authSecret: string;
  readonly bootstrapToken: string;
  readonly failSessionDeletion: () => boolean;
}

interface AuthSpikeServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

interface NamaAdministrator {
  readonly displayName: string;
  readonly email: string;
  readonly id: string;
}

interface BetterAuthUser {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}

interface BetterAuthSessionResult {
  readonly session: { readonly expiresAt: Date };
  readonly user: BetterAuthUser;
}

interface BetterAuthApi {
  readonly getSession: (input: {
    readonly headers: Headers;
  }) => Promise<BetterAuthSessionResult | null>;
  readonly signInEmail: (input: {
    readonly body: { readonly email: string; readonly password: string };
    readonly returnHeaders: true;
  }) => Promise<{ readonly headers: Headers }>;
  readonly signOut: (input: { readonly headers: Headers }) => Promise<unknown>;
  readonly signUpEmail: (input: {
    readonly body: {
      readonly email: string;
      readonly name: string;
      readonly password: string;
    };
  }) => Promise<{ readonly user: BetterAuthUser }>;
}

interface PrivateDatabaseAdapter {
  readonly [key: string]: unknown;
  readonly delete: (input: {
    readonly model: string;
    readonly where: readonly unknown[];
  }) => Promise<void>;
}

type BetterAuthFactory = (options: {
  readonly baseURL: string;
  readonly database: PrivateDatabaseFactory;
  readonly emailAndPassword: { readonly autoSignIn: false; readonly enabled: true };
  readonly logger: { readonly disabled: true };
  readonly plugins: readonly unknown[];
  readonly secret: string;
}) => { readonly api: BetterAuthApi };
type BearerFactory = (options: { readonly requireSignature: true }) => unknown;
type MemoryAdapterFactory = (
  database: Readonly<Record<string, readonly unknown[]>>,
) => PrivateDatabaseFactory;
type PrivateDatabaseFactory = (options: unknown) => PrivateDatabaseAdapter;

const runtimeRequire = createRequire(import.meta.url);
const loadExport = (specifier: string, name: string): unknown => {
  const loaded = runtimeRequire(specifier) as unknown;
  if (typeof loaded !== "object" || loaded === null || !(name in loaded)) {
    throw new Error(`missing ${name} export from ${specifier}`);
  }
  return Reflect.get(loaded, name) as unknown;
};
const betterAuth = loadExport("better-auth", "betterAuth") as BetterAuthFactory;
const memoryAdapter = loadExport(
  "better-auth/adapters/memory",
  "memoryAdapter",
) as MemoryAdapterFactory;
const bearer = loadExport("better-auth/plugins", "bearer") as BearerFactory;

const EPHEMERAL_PORT = 0;
const MILLISECONDS_PER_SECOND = 1000;
const NANOSECONDS_PER_MILLISECOND = 1_000_000;
const MISSING_ADMINISTRATOR = Symbol("missing administrator");
const administratorKey = createContextKey<NamaAdministrator | typeof MISSING_ADMINISTRATOR>(
  MISSING_ADMINISTRATOR,
);

const publicError = (code: Code, reason: string, message: string): ConnectError =>
  new ConnectError(message, code, undefined, [
    { desc: ErrorInfoSchema, value: { domain: "nama.api.v1", reason } },
  ]);

const hashSecret = (value: string): Buffer => createHash("sha256").update(value).digest();

const matchesSecret = (expectedDigest: Buffer, presented: string): boolean =>
  timingSafeEqual(expectedDigest, hashSecret(presented));

const toAdministrator = (user: {
  readonly email: string;
  readonly id: string;
  readonly name: string;
}): NamaAdministrator => ({
  displayName: user.name,
  email: user.email,
  id: user.id,
});

const toTimestamp = (date: Date): { readonly nanos: number; readonly seconds: bigint } => {
  const milliseconds = date.getTime();
  return {
    nanos: (milliseconds % MILLISECONDS_PER_SECOND) * NANOSECONDS_PER_MILLISECOND,
    seconds: BigInt(Math.floor(milliseconds / MILLISECONDS_PER_SECOND)),
  };
};

const closeServer = (server: Server): Promise<void> => {
  const { promise, reject, resolve } = Promise.withResolvers<void>();
  server.close((error) => {
    if (error !== undefined) {
      reject(error);
      return;
    }
    resolve();
  });
  return promise;
};

const startAuthSpikeServer = async ({
  authSecret,
  bootstrapToken,
  failSessionDeletion,
}: AuthSpikeOptions): Promise<AuthSpikeServer> => {
  const bootstrapDigest = hashSecret(bootstrapToken);
  const memoryDatabase = {
    account: [],
    session: [],
    user: [],
    verification: [],
  };
  const createMemoryAdapter = memoryAdapter(memoryDatabase);
  const auth = betterAuth({
    baseURL: "http://127.0.0.1",
    database: (authOptions: unknown) => {
      const adapter = createMemoryAdapter(authOptions);
      return {
        ...adapter,
        async delete(input: Parameters<typeof adapter.delete>[number]) {
          if (input.model === "session" && failSessionDeletion()) {
            throw new Error("injected session deletion failure");
          }
          await adapter.delete(input);
        },
      };
    },
    emailAndPassword: {
      autoSignIn: false,
      enabled: true,
    },
    logger: { disabled: true },
    plugins: [bearer({ requireSignature: true })],
    secret: authSecret,
  });

  let initialized = false;

  const resolveSession = async (headers: Headers) => {
    const session = await auth.api.getSession({ headers }).catch(() => {
      throw publicError(Code.Internal, "INTERNAL", "Authentication failed");
    });
    if (session === null) {
      throw publicError(Code.Unauthenticated, "CREDENTIAL_INVALID", "Authentication required");
    }
    return session;
  };

  const authenticate: Interceptor = (next) => async (request) => {
    const method = `${request.service.typeName}.${request.method.name}`;
    const authority = Reflect.get(contractAuthorityByMethod, method) as unknown;
    if (authority === undefined) {
      throw publicError(Code.PermissionDenied, "PERMISSION_DENIED", "Access denied");
    }
    if (authority !== "administrator") {
      return next(request);
    }

    const session = await resolveSession(request.header);
    request.contextValues.set(administratorKey, toAdministrator(session.user));
    return next(request);
  };

  const handler = connectNodeAdapter({
    interceptors: [authenticate],
    routes(router) {
      router.service(SetupService, {
        async createAdministrator(request) {
          if (initialized) {
            throw publicError(
              Code.FailedPrecondition,
              "ALREADY_INITIALIZED",
              "Setup is already complete",
            );
          }
          if (!matchesSecret(bootstrapDigest, request.bootstrapToken)) {
            throw publicError(
              Code.Unauthenticated,
              "AUTHENTICATION_FAILED",
              "Authentication failed",
            );
          }

          const result = await auth.api
            .signUpEmail({
              body: {
                email: request.email,
                name: request.displayName,
                password: request.password,
              },
            })
            .catch(() => {
              throw publicError(Code.Internal, "INTERNAL", "Administrator creation failed");
            });
          initialized = true;
          return { administrator: toAdministrator(result.user) };
        },
        getStatus() {
          return { initialized };
        },
      });

      router.service(AuthService, {
        getCurrentUser(_request, context) {
          const administrator = context.values.get(administratorKey);
          if (administrator === MISSING_ADMINISTRATOR) {
            throw publicError(
              Code.Unauthenticated,
              "CREDENTIAL_INVALID",
              "Authentication required",
            );
          }
          return { administrator };
        },
        async signIn(request) {
          const result = await auth.api
            .signInEmail({
              body: { email: request.email, password: request.password },
              returnHeaders: true,
            })
            .catch(() => {
              throw publicError(
                Code.Unauthenticated,
                "AUTHENTICATION_FAILED",
                "Authentication failed",
              );
            });

          const token = result.headers.get("set-auth-token");
          if (token === null || token === "") {
            throw publicError(Code.Internal, "INTERNAL", "Authentication failed");
          }

          const session = await auth.api
            .getSession({
              headers: new Headers({ authorization: `Bearer ${token}` }),
            })
            .catch(() => {
              throw publicError(Code.Internal, "INTERNAL", "Authentication failed");
            });
          if (session === null) {
            throw publicError(Code.Internal, "INTERNAL", "Authentication failed");
          }

          return {
            administrator: toAdministrator(session.user),
            credential: {
              expiresAt: toTimestamp(session.session.expiresAt),
              token,
            },
          };
        },
        async signOut(_request, context) {
          try {
            await auth.api.signOut({ headers: context.requestHeader });
          } catch {
            // Better Auth's result is not authoritative; the lookup below is.
          }

          try {
            const session = await auth.api.getSession({ headers: context.requestHeader });
            if (session === null) {
              return {};
            }
          } catch {
            // An unreadable session store cannot confirm revocation.
          }
          throw publicError(
            Code.Unavailable,
            "SESSION_REVOCATION_UNCONFIRMED",
            "Session revocation could not be confirmed",
          );
        },
      });
    },
  });

  const server = createServer(handler);
  const {
    promise: listening,
    reject: rejectListening,
    resolve: resolveListening,
  } = Promise.withResolvers<void>();
  const onError = (error: Error) => {
    server.off("listening", onListening);
    rejectListening(error);
  };
  const onListening = () => {
    server.off("error", onError);
    resolveListening();
  };
  server.once("error", onError);
  server.listen(EPHEMERAL_PORT, "127.0.0.1", onListening);
  await listening;

  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("loopback server did not expose a TCP address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
};

export { startAuthSpikeServer, type AuthSpikeOptions, type AuthSpikeServer };
