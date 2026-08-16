import { scrypt as nodeScrypt } from "node:crypto";
import type { ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

import { sql } from "drizzle-orm";
import { Effect, Layer, Redacted } from "effect";
import type { Context } from "effect";

import type {
  Administrator,
  BetterAuthAdapterService,
  CreateAdministratorInput,
  PrivateAuthenticationDefect,
} from "../../src/authentication/better-auth-adapter.ts";
import { makeSetupCoordinator } from "../../src/authentication/setup-coordinator.ts";
import type { SetupCoordinatorService } from "../../src/authentication/setup-coordinator.ts";
import { Config } from "../../src/config/config.ts";
import { Database } from "../../src/database/database.ts";
import { RuntimeControl } from "../../src/lifecycle/runtime-control.ts";
import { makeBootstrapToken } from "../../src/setup/bootstrap-token.ts";
import type { BootstrapTokenService } from "../../src/setup/bootstrap-token.ts";

interface ControlledAdapter {
  readonly adapter: BetterAuthAdapterService;
  readonly writeAttempts: () => number;
}

interface ProductionSetupServices {
  readonly bootstrapToken: BootstrapTokenService;
  readonly capturedBootstrapToken: string;
  readonly controlledAdapter: ControlledAdapter;
  readonly coordinator: SetupCoordinatorService;
  readonly runtimeControl: RecoveryRuntimeControlService;
}

interface ProductionSetupLayerInput {
  readonly databaseUrl: string;
  readonly masterKey: string;
  readonly migrationsFolder: string;
}

interface ProductionSetupInput<Result, Failure, Requirements> extends ProductionSetupLayerInput {
  readonly consumeSetup: (
    services: ProductionSetupServices,
  ) => Effect.Effect<Result, Failure, Requirements>;
  readonly makeAdapter: (database: RecoveryDatabaseService) => ControlledAdapter;
}

type AdapterPostCommitEffect = Effect.Effect<void, PrivateAuthenticationDefect>;
type CancellationPhase = "adapter-committed" | "interrupted-create-exit" | "interruption-join";
type RecoveryDatabaseService = Context.Service.Shape<typeof Database>;
type RecoveryRuntimeControlService = Context.Service.Shape<typeof RuntimeControl>;

type ScryptWithOptions = (
  ...arguments_: [
    password: string,
    salt: string,
    keyLength: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ]
) => void;

const BOOTSTRAP_OUTPUT_PREFIX = "NAMA_BOOTSTRAP_TOKEN=";
const BOOTSTRAP_TOKEN_BYTES = 32;
const BOOTSTRAP_TOKEN_FILL_BYTE = 7;
const CANCELLATION_PHASE_TIMEOUT_MILLISECONDS = 2000;
const CREDENTIAL_ACCOUNT_ID = "setup-recovery-credential-account";
const CREDENTIAL_PROVIDER_ID = "credential";
const EMPTY_VALUE_LENGTH = 0;
const HEX_RADIX = "hex";
const NOT_FOUND = -1;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_SALT_FILL_BYTE = 5;
const SCRYPT_BITS_PER_BYTE = 8;
const SCRYPT_DERIVED_KEY_BITS = 512;
const SCRYPT_KEY_LENGTH = SCRYPT_DERIVED_KEY_BITS / SCRYPT_BITS_PER_BYTE;
const SCRYPT_MAX_MEMORY_MULTIPLIER = 128;
const SCRYPT_MAX_MEMORY_PADDING_MULTIPLIER = 2;
const SCRYPT_PASSWORD_NORMALIZATION_FORM = "NFKC";
const SCRYPT_BLOCK_SIZE = 16;
const SCRYPT_COST = 16_384;
const SCRYPT_MAX_MEMORY =
  SCRYPT_MAX_MEMORY_MULTIPLIER *
  SCRYPT_COST *
  SCRYPT_BLOCK_SIZE *
  SCRYPT_MAX_MEMORY_PADDING_MULTIPLIER;
const SCRYPT_PARALLELIZATION = 1;
const SINGLE_WRITE_ATTEMPT = 1;
const SCRYPT_OPTIONS = Object.freeze({
  blockSize: SCRYPT_BLOCK_SIZE,
  cost: SCRYPT_COST,
  maxmem: SCRYPT_MAX_MEMORY,
  parallelization: SCRYPT_PARALLELIZATION,
});
const PRIVATE_AUTHENTICATION_DEFECT: PrivateAuthenticationDefect = Object.freeze({
  _tag: "PrivateAuthenticationDefect",
});
const failAfterCommittedAdapterWrite = Effect.fail(PRIVATE_AUTHENTICATION_DEFECT);
const SERVER_BIND_ADDRESS = "127.0.0.1:8080";
const SERVER_PUBLIC_URL = "http://localhost:8080/";
const scryptWithOptions: ScryptWithOptions = nodeScrypt;
const deriveScryptKey = promisify(scryptWithOptions);

const hashCredentialPassword = async (password: string): Promise<string> => {
  const saltBytes = Buffer.alloc(PASSWORD_SALT_BYTES, PASSWORD_SALT_FILL_BYTE);
  const encodedSalt = saltBytes.toString(HEX_RADIX);
  let derivedKey: Buffer = Buffer.alloc(EMPTY_VALUE_LENGTH);
  try {
    derivedKey = await deriveScryptKey(
      password.normalize(SCRYPT_PASSWORD_NORMALIZATION_FORM),
      encodedSalt,
      SCRYPT_KEY_LENGTH,
      SCRYPT_OPTIONS,
    );
    return `${encodedSalt}:${derivedKey.toString(HEX_RADIX)}`;
  } finally {
    derivedKey.fill(EMPTY_VALUE_LENGTH);
    saltBytes.fill(EMPTY_VALUE_LENGTH);
  }
};

const bootstrapTokenFromCapturedOutput = (capturedBootstrapOutput: string): string => {
  if (
    !capturedBootstrapOutput.startsWith(BOOTSTRAP_OUTPUT_PREFIX) ||
    !capturedBootstrapOutput.endsWith("\n")
  ) {
    throw new Error("expected captured bootstrap token output");
  }

  const bootstrapToken = capturedBootstrapOutput.slice(BOOTSTRAP_OUTPUT_PREFIX.length, NOT_FOUND);
  if (bootstrapToken.length === EMPTY_VALUE_LENGTH) {
    throw new Error("expected a non-empty captured bootstrap token");
  }
  return bootstrapToken;
};

const insertAdministratorAndCredential = async (
  database: RecoveryDatabaseService,
  administrator: Administrator,
  input: CreateAdministratorInput,
): Promise<void> => {
  const { email, name, password } = input;
  const credentialPasswordHash = await hashCredentialPassword(password);
  const { authentication } = database;
  await authentication.database.transaction(async (transaction) => {
    await transaction.execute(sql`
      INSERT INTO "user" (id, name, email, email_verified)
      VALUES (${administrator.id}, ${name}, ${email.toLowerCase()}, ${false})
    `);
    await transaction.execute(sql`
      INSERT INTO account (id, account_id, provider_id, user_id, password, updated_at)
      VALUES (
        ${CREDENTIAL_ACCOUNT_ID},
        ${administrator.id},
        ${CREDENTIAL_PROVIDER_ID},
        ${administrator.id},
        ${credentialPasswordHash},
        transaction_timestamp()
      )
    `);
  });
};

const makeCommittedAdapter = (
  database: RecoveryDatabaseService,
  administrator: Administrator,
  afterCommit: AdapterPostCommitEffect,
): ControlledAdapter => {
  let writeAttempts = 0;
  const createAdministrator: BetterAuthAdapterService["createAdministrator"] = (input) =>
    Effect.tryPromise({
      catch: () => PRIVATE_AUTHENTICATION_DEFECT,
      try: async () => {
        writeAttempts += SINGLE_WRITE_ATTEMPT;
        await insertAdministratorAndCredential(database, administrator, input);
      },
    }).pipe(Effect.andThen(afterCommit), Effect.as(administrator));

  return Object.freeze({
    adapter: Object.freeze({
      createAdministrator,
      resolveBearer: () => Effect.fail(PRIVATE_AUTHENTICATION_DEFECT),
      signIn: () => Effect.fail(PRIVATE_AUTHENTICATION_DEFECT),
      signOut: () => Effect.fail(PRIVATE_AUTHENTICATION_DEFECT),
    }),
    writeAttempts: () => writeAttempts,
  });
};

const makeProductionSetupLayers = ({
  databaseUrl,
  masterKey,
  migrationsFolder,
}: ProductionSetupLayerInput) => {
  const configuration = Config.of({
    database: Object.freeze({ maxConnections: 3, url: Redacted.make(databaseUrl) }),
    logging: Object.freeze({ level: "info" as const }),
    security: Object.freeze({ masterKey: Redacted.make(masterKey) }),
    server: Object.freeze({ bind: SERVER_BIND_ADDRESS, publicUrl: SERVER_PUBLIC_URL }),
  });
  const configurationLayer = Layer.succeed(Config, configuration);
  const databaseLayer = Database.layer(migrationsFolder).pipe(Layer.provide(configurationLayer));
  return Layer.mergeAll(configurationLayer, databaseLayer, RuntimeControl.layer);
};

const useProductionSetup = <Result, Failure, Requirements>(
  input: ProductionSetupInput<Result, Failure, Requirements>,
) => {
  const { consumeSetup, makeAdapter } = input;
  const dependencies = makeProductionSetupLayers(input);
  const program = Effect.gen(function* productionSetup() {
    const database = yield* Database;
    const runtimeControl = yield* RuntimeControl;
    let capturedBootstrapOutput = "";
    const bootstrapToken = makeBootstrapToken(database.initialization, {
      randomBytes: () => Buffer.alloc(BOOTSTRAP_TOKEN_BYTES, BOOTSTRAP_TOKEN_FILL_BYTE),
      writeLine: (line) => {
        capturedBootstrapOutput = line;
        return Buffer.byteLength(line);
      },
    });
    yield* bootstrapToken.activate;
    const controlledAdapter = makeAdapter(database);
    const coordinator = makeSetupCoordinator({
      betterAuthAdapter: controlledAdapter.adapter,
      bootstrapToken,
      database,
      initialization: database.initialization,
      runtimeControl,
    });

    return yield* consumeSetup({
      bootstrapToken,
      capturedBootstrapToken: bootstrapTokenFromCapturedOutput(capturedBootstrapOutput),
      controlledAdapter,
      coordinator,
      runtimeControl,
    });
  });
  return Effect.scoped(program.pipe(Effect.provide(dependencies)));
};

const awaitCancellationPhase = <Success, Failure, Requirements>(
  phase: CancellationPhase,
  effect: Effect.Effect<Success, Failure, Requirements>,
) => {
  const timeout = Effect.sleep(CANCELLATION_PHASE_TIMEOUT_MILLISECONDS);
  const phaseFailure = Effect.die(new Error(phase));
  const timeoutFailure = timeout.pipe(Effect.andThen(phaseFailure));
  return Effect.raceFirst(effect, timeoutFailure);
};

const hasFailureTag = (failure: unknown, tag: string): boolean =>
  typeof failure === "object" &&
  failure !== null &&
  !Array.isArray(failure) &&
  "_tag" in failure &&
  failure["_tag"] === tag;

export {
  awaitCancellationPhase,
  failAfterCommittedAdapterWrite,
  hasFailureTag,
  makeCommittedAdapter,
  useProductionSetup,
  type AdapterPostCommitEffect,
  type CancellationPhase,
  type ControlledAdapter,
  type ProductionSetupInput,
  type ProductionSetupLayerInput,
  type ProductionSetupServices,
  type RecoveryDatabaseService,
  type RecoveryRuntimeControlService,
};
