// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-underscore-dangle, eslint/no-useless-escape, sort-keys, typescript/no-unsafe-type-assertion, unicorn/max-nested-calls -- Production-migration security scenarios keep exact PostgreSQL faults, cryptographic dimensions, and sentinels visible.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Pool } from "pg";

import type {
  ProviderInstanceInput,
  ProviderPersistence,
} from "../../src/database/provider-persistence.ts";
import { insertFixtureUser } from "./database-constraint.test-support.ts";
import {
  productionMigrations,
  useConfiguredDatabase,
  useDatabase,
  withPool,
} from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const ADMINISTRATOR_ID = "provider-administrator";
const DELETE_METHOD = "nama.api.v1.ProviderService.DeleteProviderInstance" as const;
const CREATE_METHOD = "nama.api.v1.ProviderService.CreateProviderInstance" as const;
const INSTANCE_ID = "provider-instance-1";
const PROVIDER_TYPE_ID = "jellyfin";
const REVISION = "revision-1";
const SECRET_VALUE = "provider-credential-sentinel";
const WRONG_MASTER_KEY = `base64:${Buffer.alloc(32, 9).toString("base64")}`;

const acceptJellyfinInstallation = (
  providers: ProviderPersistence,
  providerTypeId = PROVIDER_TYPE_ID,
) =>
  providers.acceptInstallation({
    capabilities: [],
    configurationSchema: {
      additionalProperties: false,
      properties: {
        api_key: { type: "string", writeOnly: true },
        base_url: { type: "string" },
        password: { type: "string", writeOnly: true },
      },
      required: ["api_key", "base_url"],
      type: "object",
    },
    contractMajor: 1,
    description: "Jellyfin provider",
    displayName: "Jellyfin",
    pluginBuildVersion: "1.0.0",
    providerTypeId,
    schemaProfileVersion: 1,
    schemaRevision: "schema-1",
  });

const makeInstanceInput = (
  id: string,
  syncPriority?: number,
  principalReference = "provider-principal-sentinel",
): ProviderInstanceInput => {
  const operationId = `${id}-operation`;
  const input = {
    configuration: { base_url: "https://jellyfin.example.test/" },
    credentials: { api_key: SECRET_VALUE },
    displayName: "Home",
    enabled: true,
    id,
    observation: { status: "healthy" as const, summary: "Connected" },
    operation: {
      administratorUserId: ADMINISTRATOR_ID,
      canonicalRequest: Buffer.from(`{"operation_id":"${operationId}"}`, "utf8"),
      method: CREATE_METHOD,
      operationId,
      serializedResult: { providerInstanceId: id },
    },
    principalReference,
    providerTypeId: PROVIDER_TYPE_ID,
    revision: REVISION,
  };
  if (syncPriority === undefined) {
    return input;
  }
  return { ...input, syncPriority };
};

interface PostgresFailureIdentity {
  readonly code: string;
  readonly identity: string;
}

interface ExpectedPostgresFailure extends PostgresFailureIdentity {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

const matchesPostgresFailure = (error: unknown, expected: PostgresFailureIdentity): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const record = error as Record<string, unknown>;
  const { code, constraint, message } = record;
  return (
    code === expected.code && (constraint === expected.identity || message === expected.identity)
  );
};

const queryRejectedBy = (pool: Pool, expected: ExpectedPostgresFailure): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    try {
      await pool.query(expected.text, (expected.values ?? []) as unknown[]);
      return false;
    } catch (error) {
      return matchesPostgresFailure(error, expected);
    }
  });

const checkViolation = (
  identity: string,
  text: string,
  values?: readonly unknown[],
): ExpectedPostgresFailure => ({ code: "23514", identity, text, values });

const uniqueViolation = (
  identity: string,
  text: string,
  values?: readonly unknown[],
): ExpectedPostgresFailure => ({ code: "23505", identity, text, values });

const initializeProviderDatabase = (databaseUrl: string) =>
  Effect.gen(function* initializeProviderDatabaseFixture() {
    yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
    yield* withPool(databaseUrl, (pool) =>
      insertFixtureUser(pool, ADMINISTRATOR_ID, "provider-administrator@example.test"),
    );
  });

it.live("persists non-secret configuration and restores every encrypted credential", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* encryptedRoundTripTest() {
      yield* initializeProviderDatabase(databaseUrl);

      const stored = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* providerPersistenceRoundTrip() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
          const instance = yield* database.providers.loadInstance(INSTANCE_ID);
          const instanceIds =
            yield* database.providers.listInstallationInstanceIds(PROVIDER_TYPE_ID);
          return { instance, instanceIds };
        }),
      );

      expect({
        configurationStored:
          stored.instance.configuration["base_url"] === "https://jellyfin.example.test/",
        credentialRecovered: stored.instance.credentials["api_key"] === SECRET_VALUE,
        instanceEnumerated:
          stored.instanceIds.length === 1 && stored.instanceIds[0] === INSTANCE_ID,
        providerTypeRetained: stored.instance.providerTypeId === PROVIDER_TYPE_ID,
        revisionRetained: stored.instance.revision === REVISION,
      }).toEqual({
        configurationStored: true,
        credentialRecovered: true,
        instanceEnumerated: true,
        providerTypeRetained: true,
        revisionRetained: true,
      });
    }),
  ),
);

it.live("reads accepted provider installations in stable keyset order", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* installationReadTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const result = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* installationReadPersistence() {
          yield* acceptJellyfinInstallation(database.providers, "zeta");
          yield* acceptJellyfinInstallation(database.providers, "jellyfin");
          yield* acceptJellyfinInstallation(database.providers, "alpha");
          yield* acceptJellyfinInstallation(database.providers, "removed");
          const providerTypeIds = ["alpha", "jellyfin", "zeta"];
          const firstPage = yield* database.providers.listInstallations({
            limit: 2,
            providerTypeIds,
          });
          const cursor = firstPage.at(-1)?.providerTypeId;
          if (cursor === undefined) {
            return yield* Effect.die(new Error("expected a provider installation cursor"));
          }
          const secondPage = yield* database.providers.listInstallations({
            afterProviderTypeId: cursor,
            limit: 2,
            providerTypeIds,
          });
          const installation = yield* database.providers.loadInstallation("jellyfin");
          return { firstPage, installation, secondPage };
        }),
      );

      expect(result.firstPage.map(({ providerTypeId }) => providerTypeId)).toEqual([
        "alpha",
        "jellyfin",
      ]);
      expect(result.secondPage.map(({ providerTypeId }) => providerTypeId)).toEqual(["zeta"]);
      expect(result.installation).toMatchObject({
        displayName: "Jellyfin",
        pluginBuildVersion: "1.0.0",
        providerTypeId: "jellyfin",
        schemaRevision: "schema-1",
      });
    }),
  ),
);

it.live("allocates an omitted sync priority after the current maximum", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* defaultPriorityTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const assignedPriority = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* createDefaultPriorityInstance() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput("priority-explicit", 7));
          yield* database.providers.createInstance(makeInstanceInput("priority-default"));
          const stored = yield* database.providers.loadInstance("priority-default");
          return stored.syncPriority;
        }),
      );

      expect(assignedPriority === 8).toBe(true);
    }),
  ),
);

it.live("rejects secrets in non-secret JSONB and credentials for ordinary keys", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* credentialClassificationTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* createClassifiedInstance() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
        }),
      );

      const rejected = yield* withPool(databaseUrl, (pool) =>
        Effect.all({
          credential: queryRejectedBy(
            pool,
            checkViolation(
              "provider credential classification invalid",
              `INSERT INTO provider_credential (
                provider_instance_id,
                configuration_key,
                envelope_version,
                nonce,
                ciphertext,
                authentication_tag
              ) VALUES ($1, 'base_url', 1, $2, $3, $4)`,
              [INSTANCE_ID, Buffer.alloc(12), Buffer.alloc(0), Buffer.alloc(16)],
            ),
          ),
          secretInConfiguration: queryRejectedBy(
            pool,
            checkViolation(
              "provider configuration violates secret partition",
              "UPDATE provider_instance SET configuration = $2::jsonb WHERE id = $1",
              [INSTANCE_ID, JSON.stringify({ api_key: "must-not-persist" })],
            ),
          ),
        }),
      );

      expect(rejected).toEqual({
        credential: true,
        secretInConfiguration: true,
      });
    }),
  ),
);

it.live("uses a fresh complete AES-256-GCM envelope for every credential row", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* freshEnvelopeTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* createRepeatedCredentialValues() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput("provider-instance-a", 1));
          yield* database.providers.createInstance(makeInstanceInput("provider-instance-b", 2));
        }),
      );

      const facts = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{
            readonly ciphertext_is_opaque: boolean;
            readonly complete_envelopes: boolean;
            readonly fresh_nonces: boolean;
          }>(
            `SELECT
              bool_and(
                envelope_version = 1
                AND octet_length(nonce) = 12
                AND octet_length(authentication_tag) = 16
              ) AS complete_envelopes,
              count(DISTINCT encode(nonce, 'hex')) = count(*) AS fresh_nonces,
              bool_and(position(convert_to($1, 'UTF8') in ciphertext) = 0)
                AS ciphertext_is_opaque
            FROM provider_credential`,
            [SECRET_VALUE],
          );
          return result.rows.at(0);
        }),
      );

      expect(facts).toEqual({
        ciphertext_is_opaque: true,
        complete_envelopes: true,
        fresh_nonces: true,
      });
    }),
  ),
);

it.live("fails closed for moved, key-transplanted, tampered, and unsupported envelopes", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* invalidEnvelopeTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* createEnvelopeFixtures() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput("envelope-source", 1));
          yield* database.providers.createInstance(makeInstanceInput("envelope-moved", 2));
          yield* database.providers.createInstance(makeInstanceInput("envelope-tampered", 3));
          yield* database.providers.createInstance(makeInstanceInput("envelope-unsupported", 4));
          const keyMoved = makeInstanceInput("envelope-key-moved", 5);
          yield* database.providers.createInstance({
            ...keyMoved,
            credentials: { api_key: SECRET_VALUE, password: SECRET_VALUE },
          });
          yield* acceptJellyfinInstallation(database.providers, "alternate-provider");
          const providerTypeMoved = makeInstanceInput("envelope-provider-moved", 6);
          yield* database.providers.createInstance({
            ...providerTypeMoved,
            providerTypeId: "alternate-provider",
          });
        }),
      );
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          await pool.query(
            `UPDATE provider_credential AS target
            SET
              envelope_version = source.envelope_version,
              nonce = source.nonce,
              ciphertext = source.ciphertext,
              authentication_tag = source.authentication_tag
            FROM provider_credential AS source
            WHERE target.provider_instance_id = 'envelope-moved'
              AND source.provider_instance_id = 'envelope-source'`,
          );
          await pool.query(
            `UPDATE provider_credential AS target
            SET
              envelope_version = source.envelope_version,
              nonce = source.nonce,
              ciphertext = source.ciphertext,
              authentication_tag = source.authentication_tag
            FROM provider_credential AS source
            WHERE target.provider_instance_id = 'envelope-key-moved'
              AND target.configuration_key = 'password'
              AND source.provider_instance_id = 'envelope-key-moved'
              AND source.configuration_key = 'api_key'`,
          );
          await pool.query(
            `UPDATE provider_credential AS target
            SET
              envelope_version = source.envelope_version,
              nonce = source.nonce,
              ciphertext = source.ciphertext,
              authentication_tag = source.authentication_tag
            FROM provider_credential AS source
            WHERE target.provider_instance_id = 'envelope-provider-moved'
              AND source.provider_instance_id = 'envelope-source'`,
          );
          await pool.query(
            `UPDATE provider_credential
            SET authentication_tag = set_byte(
              authentication_tag,
              0,
              get_byte(authentication_tag, 0) # 1
            )
            WHERE provider_instance_id = 'envelope-tampered'`,
          );
          await pool.query(
            `UPDATE provider_credential
            SET envelope_version = 2
            WHERE provider_instance_id = 'envelope-unsupported'`,
          );
        }),
      );

      const results = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* authenticateStoredEnvelopes() {
          const source = yield* database.providers.loadInstance("envelope-source");
          const moved = yield* Effect.flip(database.providers.loadInstance("envelope-moved"));
          const tampered = yield* Effect.flip(database.providers.loadInstance("envelope-tampered"));
          const unsupported = yield* Effect.flip(
            database.providers.loadInstance("envelope-unsupported"),
          );
          const keyMoved = yield* Effect.flip(
            database.providers.loadInstance("envelope-key-moved"),
          );
          const providerTypeMoved = yield* Effect.flip(
            database.providers.loadInstance("envelope-provider-moved"),
          );
          return {
            keyMoved: keyMoved._tag,
            moved: moved._tag,
            retainedSourceCredential: source.credentials["api_key"] === SECRET_VALUE,
            providerTypeMoved: providerTypeMoved._tag,
            tampered: tampered._tag,
            unsupported: unsupported._tag,
          };
        }),
      );
      const retainedCredentialCount = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{ readonly count: number }>(
            "SELECT count(*)::integer AS count FROM provider_credential",
          );
          return result.rows.at(0)?.count;
        }),
      );

      expect(results).toEqual({
        moved: "ProviderCredentialsUnavailable",
        keyMoved: "ProviderCredentialsUnavailable",
        retainedSourceCredential: true,
        providerTypeMoved: "ProviderCredentialsUnavailable",
        tampered: "ProviderCredentialsUnavailable",
        unsupported: "ProviderCredentialsUnavailable",
      });
      expect(retainedCredentialCount).toBe(7);
    }),
  ),
);

it.live("marks an instance unavailable when a required credential row is missing", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* missingCredentialTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const createFailureTag = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistRequiredCredential() {
          yield* acceptJellyfinInstallation(database.providers);
          const input = makeInstanceInput("missing-on-create", 1);
          const failure = yield* Effect.flip(
            database.providers.createInstance({ ...input, credentials: {} }),
          );
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
          return failure._tag;
        }),
      );
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            "DELETE FROM provider_credential WHERE provider_instance_id = $1 AND configuration_key = 'api_key'",
            [INSTANCE_ID],
          ),
        ),
      );

      const failureTag = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.map(
          Effect.flip(database.providers.loadInstance(INSTANCE_ID)),
          (failure) => failure._tag,
        ),
      );

      expect({
        createFailureTag,
        startupFailureTag: failureTag,
      }).toEqual({
        createFailureTag: "ProviderPersistenceError",
        startupFailureTag: "ProviderCredentialsUnavailable",
      });
    }),
  ),
);

it.live("keeps credential recovery retryable after a transient database failure", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* retryableCredentialReadTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const outcome = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* retryCredentialRead() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
          const failure = yield* withPool(databaseUrl, (locker) =>
            Effect.acquireUseRelease(
              Effect.promise(async () => {
                await locker.query("BEGIN");
                await locker.query("LOCK TABLE provider_credential IN ACCESS EXCLUSIVE MODE");
              }),
              () => Effect.flip(database.providers.loadInstance(INSTANCE_ID)),
              () => Effect.promise(() => locker.query("ROLLBACK")),
            ),
          );
          const recovered = yield* database.providers.loadInstance(INSTANCE_ID);
          return {
            recovered: recovered.credentials["api_key"] === SECRET_VALUE,
            transientFailure: failure._tag,
          };
        }),
      );

      expect(outcome).toEqual({
        recovered: true,
        transientFailure: "ProviderPersistenceError",
      });
    }),
  ),
);

it.live("rejects credential recovery and principal comparison under the wrong master key", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* wrongMasterKeyTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistProtectedInstance() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
        }),
      );

      const failures = yield* useConfiguredDatabase(databaseUrl, productionMigrations, {
        masterKey: WRONG_MASTER_KEY,
        use: (database) =>
          Effect.gen(function* rejectWrongMasterKey() {
            const credentials = yield* Effect.flip(database.providers.loadInstance(INSTANCE_ID));
            const principal = yield* Effect.flip(
              database.providers.matchesPrincipal(INSTANCE_ID, "provider-principal-sentinel"),
            );
            return { credentials: credentials._tag, principal: principal._tag };
          }),
      });

      expect(failures).toEqual({
        credentials: "ProviderCredentialsUnavailable",
        principal: "ProviderCredentialsUnavailable",
      });
    }),
  ),
);

it.live("stores immutable instance-bound principal HMACs and discards raw references", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* principalBindingTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const comparisons = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistPrincipalBindings() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(
            makeInstanceInput("principal-instance-a", 1, "shared-provider-principal"),
          );
          yield* database.providers.createInstance(
            makeInstanceInput("principal-instance-b", 2, "shared-provider-principal"),
          );
          return {
            first: yield* database.providers.matchesPrincipal(
              "principal-instance-a",
              "shared-provider-principal",
            ),
            second: yield* database.providers.matchesPrincipal(
              "principal-instance-b",
              "shared-provider-principal",
            ),
            wrong: yield* database.providers.matchesPrincipal(
              "principal-instance-a",
              "different-provider-principal",
            ),
          };
        }),
      );
      const persisted = yield* withPool(databaseUrl, (pool) =>
        Effect.all({
          facts: Effect.promise(async () => {
            const result = await pool.query<{
              readonly complete_digests: boolean;
              readonly instance_separated: boolean;
              readonly raw_reference_discarded: boolean;
            }>(
              `SELECT
                bool_and(octet_length(principal_digest) = 32) AS complete_digests,
                count(DISTINCT encode(principal_digest, 'hex')) = count(*)
                  AS instance_separated,
                bool_and(
                  position(convert_to($1, 'UTF8') in principal_digest) = 0
                ) AS raw_reference_discarded
              FROM provider_instance`,
              ["shared-provider-principal"],
            );
            return result.rows.at(0);
          }),
          immutable: queryRejectedBy(
            pool,
            checkViolation(
              "provider instance binding is immutable",
              "UPDATE provider_instance SET principal_digest = $2 WHERE id = $1",
              ["principal-instance-a", Buffer.alloc(32, 7)],
            ),
          ),
        }),
      );

      expect(comparisons).toEqual({ first: true, second: true, wrong: false });
      expect(persisted).toEqual({
        facts: {
          complete_digests: true,
          instance_separated: true,
          raw_reference_discarded: true,
        },
        immutable: true,
      });
    }),
  ),
);

it.live("retains scoped keyed operation results for seven days after instance deletion", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* operationResultRetentionTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const createCanonicalRequest = Buffer.from(
        JSON.stringify({ api_key: SECRET_VALUE, operation_id: "create-retained" }),
        "utf8",
      );
      const createInput = makeInstanceInput(INSTANCE_ID, 1);
      const deleteOperation = {
        administratorUserId: ADMINISTRATOR_ID,
        canonicalRequest: Buffer.from(
          JSON.stringify({
            operation_id: "delete-retained",
            provider_instance_id: INSTANCE_ID,
          }),
          "utf8",
        ),
        method: DELETE_METHOD,
        operationId: "delete-retained",
        serializedResult: {},
      } as const;

      const replay = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* retainOperationResults() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance({
            ...createInput,
            operation: {
              ...createInput.operation,
              canonicalRequest: createCanonicalRequest,
              operationId: "create-retained",
            },
          });
          const deleted = yield* database.providers.deleteInstance({
            operation: deleteOperation,
            providerInstanceId: INSTANCE_ID,
          });
          const createResult = yield* database.providers.readOperationResult({
            administratorUserId: ADMINISTRATOR_ID,
            canonicalRequest: createCanonicalRequest,
            method: CREATE_METHOD,
            operationId: "create-retained",
          });
          const deleteResult = yield* database.providers.readOperationResult(deleteOperation);
          const reused = yield* Effect.flip(
            database.providers.readOperationResult({
              administratorUserId: ADMINISTRATOR_ID,
              canonicalRequest: Buffer.from('{\"different\":true}', "utf8"),
              method: CREATE_METHOD,
              operationId: "create-retained",
            }),
          );
          return {
            createResult,
            deleteResult,
            deleted,
            reused: reused._tag,
          };
        }),
      );
      const storedFacts = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{
            readonly fingerprints_are_keyed: boolean;
            readonly retained_after_delete: boolean;
            readonly seven_day_minimum: boolean;
          }>(
            `SELECT
              bool_and(
                octet_length(request_fingerprint) = 32
                AND position(convert_to($1, 'UTF8') in request_fingerprint) = 0
              ) AS fingerprints_are_keyed,
              count(*) = 2 AS retained_after_delete,
              bool_and(expires_at >= completed_at + interval '7 days')
                AS seven_day_minimum
            FROM provider_operation_result`,
            [SECRET_VALUE],
          );
          return result.rows.at(0);
        }),
      );

      expect(replay).toEqual({
        createResult: { providerInstanceId: INSTANCE_ID },
        deleteResult: {},
        deleted: true,
        reused: "ProviderOperationKeyReused",
      });
      expect(storedFacts).toEqual({
        fingerprints_are_keyed: true,
        retained_after_delete: true,
        seven_day_minimum: true,
      });
    }),
  ),
);

it.live("keeps accepted secret classification monotonic across installation updates", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* monotonicClassificationTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistClassifiedInstallation() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
        }),
      );

      const rejected = yield* withPool(databaseUrl, (pool) =>
        Effect.all({
          existingSecretReclassified: queryRejectedBy(
            pool,
            checkViolation(
              "provider secret classification is monotonic",
              `UPDATE provider_installation
              SET configuration_schema = jsonb_set(
                configuration_schema,
                '{properties,api_key,writeOnly}',
                'false'::jsonb
              )
              WHERE provider_type_id = $1`,
              [PROVIDER_TYPE_ID],
            ),
          ),
          storedOrdinaryValueReclassified: queryRejectedBy(
            pool,
            checkViolation(
              "stored provider configuration conflicts with secret classification",
              `UPDATE provider_installation
              SET configuration_schema = jsonb_set(
                configuration_schema,
                '{properties,base_url,writeOnly}',
                'true'::jsonb
              )
              WHERE provider_type_id = $1`,
              [PROVIDER_TYPE_ID],
            ),
          ),
        }),
      );

      expect(rejected).toEqual({
        existingSecretReclassified: true,
        storedOrdinaryValueReclassified: true,
      });
    }),
  ),
);

it.live("rolls back every provider record when the final operation-result write fails", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* providerTransactionRollbackTest() {
      yield* initializeProviderDatabase(databaseUrl);

      const failureTag = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* collideAtOperationResult() {
          yield* acceptJellyfinInstallation(database.providers);
          const committed = makeInstanceInput("committed-instance", 1);
          yield* database.providers.createInstance(committed);
          const rolledBack = makeInstanceInput("rolled-back-instance", 2);
          const failure = yield* Effect.flip(
            database.providers.createInstance({
              ...rolledBack,
              operation: committed.operation,
            }),
          );
          return failure._tag;
        }),
      );
      const retainedCounts = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{
            readonly credential_count: number;
            readonly instance_count: number;
            readonly observation_count: number;
            readonly operation_count: number;
          }>(
            `SELECT
              (SELECT count(*)::integer FROM provider_instance) AS instance_count,
              (SELECT count(*)::integer FROM provider_credential) AS credential_count,
              (SELECT count(*)::integer FROM provider_instance_observation)
                AS observation_count,
              (SELECT count(*)::integer FROM provider_operation_result) AS operation_count`,
          );
          return result.rows.at(0);
        }),
      );

      expect(failureTag).toBe("ProviderPersistenceError");
      expect(retainedCounts).toEqual({
        credential_count: 1,
        instance_count: 1,
        observation_count: 1,
        operation_count: 1,
      });
    }),
  ),
);

it.live("enforces provider identity, revision, lifecycle, uniqueness, and ledger invariants", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* providerConstraintTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistConstraintFixture() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
        }),
      );

      const rejected = yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* exerciseProviderConstraints() {
          const providerInstanceValues = [
            PROVIDER_TYPE_ID,
            Buffer.alloc(32, 1),
            JSON.stringify({}),
          ] as const;
          const emptyIdentity = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider_instance_id_check",
              `INSERT INTO provider_instance (
                id,
                provider_type_id,
                display_name,
                enabled,
                sync_priority,
                configuration,
                principal_digest,
                revision
              ) VALUES ('', $1, 'Invalid', false, 2, $3::jsonb, $2, 'revision')`,
              providerInstanceValues,
            ),
          );
          const emptyRevision = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider_instance_revision_check",
              `INSERT INTO provider_instance (
                id,
                provider_type_id,
                display_name,
                enabled,
                sync_priority,
                configuration,
                principal_digest,
                revision
              ) VALUES ('empty-revision', $1, 'Invalid', false, 3, $3::jsonb, $2, '')`,
              providerInstanceValues,
            ),
          );
          const duplicateEnabledPriority = yield* queryRejectedBy(
            pool,
            uniqueViolation(
              "provider_instance_enabled_sync_priority_unique",
              `INSERT INTO provider_instance (
                id,
                provider_type_id,
                display_name,
                enabled,
                sync_priority,
                configuration,
                principal_digest,
                revision
              ) VALUES ('priority-conflict', $1, 'Invalid', true, 1, $3::jsonb, $2, 'revision')`,
              providerInstanceValues,
            ),
          );
          const malformedEnvelope = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider_credential_nonce_check",
              "UPDATE provider_credential SET nonce = $2 WHERE provider_instance_id = $1",
              [INSTANCE_ID, Buffer.alloc(11)],
            ),
          );
          const staleObservation = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider observation revision is not current",
              "UPDATE provider_instance_observation SET instance_revision = 'stale-revision' WHERE provider_instance_id = $1",
              [INSTANCE_ID],
            ),
          );
          const shortRetention = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider_operation_result_retention_check",
              `INSERT INTO provider_operation_result (
                administrator_user_id,
                method,
                operation_id,
                request_fingerprint,
                serialized_result,
                completed_at,
                expires_at
              ) VALUES (
                $1,
                'nama.api.v1.ProviderService.UpdateProviderInstance',
                'short-retention',
                $2,
                '{}'::jsonb,
                transaction_timestamp(),
                transaction_timestamp() + interval '1 day'
              )`,
              [ADMINISTRATOR_ID, Buffer.alloc(32, 2)],
            ),
          );
          const unknownMethod = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider_operation_result_method_check",
              `INSERT INTO provider_operation_result (
                administrator_user_id,
                method,
                operation_id,
                request_fingerprint,
                serialized_result
              ) VALUES ($1, 'unknown.Method', 'unknown-method', $2, '{}'::jsonb)`,
              [ADMINISTRATOR_ID, Buffer.alloc(32, 2)],
            ),
          );
          const instanceLimit = yield* queryRejectedBy(
            pool,
            checkViolation(
              "provider instance limit exceeded",
              `INSERT INTO provider_instance (
                id,
                provider_type_id,
                display_name,
                enabled,
                sync_priority,
                configuration,
                principal_digest,
                revision
              )
              SELECT
                'bulk-' || value::text,
                $1,
                'Bulk',
                false,
                100 + value,
                '{}'::jsonb,
                $2,
                'revision'
              FROM generate_series(1, 100) AS value`,
              [PROVIDER_TYPE_ID, Buffer.alloc(32, 3)],
            ),
          );
          return {
            duplicateEnabledPriority,
            emptyIdentity,
            emptyRevision,
            instanceLimit,
            malformedEnvelope,
            shortRetention,
            staleObservation,
            unknownMethod,
          };
        }),
      );
      const instanceCount = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{ readonly count: number }>(
            "SELECT count(*)::integer AS count FROM provider_instance",
          );
          return result.rows.at(0)?.count;
        }),
      );

      expect(rejected).toEqual({
        duplicateEnabledPriority: true,
        emptyIdentity: true,
        emptyRevision: true,
        instanceLimit: true,
        malformedEnvelope: true,
        shortRetention: true,
        staleObservation: true,
        unknownMethod: true,
      });
      expect(instanceCount).toBe(1);
    }),
  ),
);

it.live("holds the 100-instance limit across concurrent transactions", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* concurrentInstanceLimitTest() {
      yield* initializeProviderDatabase(databaseUrl);
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        acceptJellyfinInstallation(database.providers),
      );
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(
            `INSERT INTO provider_instance (
              id,
              provider_type_id,
              display_name,
              enabled,
              sync_priority,
              configuration,
              principal_digest,
              revision
            )
            SELECT
              'seed-' || value::text,
              $1,
              'Seed',
              false,
              value,
              '{}'::jsonb,
              $2,
              'revision'
            FROM generate_series(1, 99) AS value`,
            [PROVIDER_TYPE_ID, Buffer.alloc(32, 5)],
          ),
        ),
      );
      const insertSql = `INSERT INTO provider_instance (
        id,
        provider_type_id,
        display_name,
        enabled,
        sync_priority,
        configuration,
        principal_digest,
        revision
      ) VALUES ($1, $2, 'Race', false, $3, '{}'::jsonb, $4, 'revision')`;
      const race = yield* withPool(databaseUrl, (first) =>
        withPool(databaseUrl, (second) =>
          Effect.promise(async () => {
            const results = await Promise.allSettled([
              first.query(insertSql, ["race-first", PROVIDER_TYPE_ID, 100, Buffer.alloc(32, 6)]),
              second.query(insertSql, ["race-second", PROVIDER_TYPE_ID, 101, Buffer.alloc(32, 7)]),
            ]);
            const rejected = results.find((result) => result.status === "rejected");
            return {
              committed: results.filter((result) => result.status === "fulfilled").length,
              rejectedByLimit:
                rejected?.status === "rejected" &&
                matchesPostgresFailure(rejected.reason, {
                  code: "23514",
                  identity: "provider instance limit exceeded",
                }),
            };
          }),
        ),
      );
      const count = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{ readonly count: number }>(
            "SELECT count(*)::integer AS count FROM provider_instance",
          );
          return result.rows.at(0)?.count;
        }),
      );

      expect(race).toEqual({ committed: 1, rejectedByLimit: true });
      expect(count).toBe(100);
    }),
  ),
);

it.live("commits observations only for the current provider-instance revision", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* conditionalObservationTest() {
      yield* initializeProviderDatabase(databaseUrl);

      const writes = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* writeConditionalObservations() {
          yield* acceptJellyfinInstallation(database.providers);
          yield* database.providers.createInstance(makeInstanceInput(INSTANCE_ID, 1));
          const current = yield* database.providers.recordObservation({
            providerInstanceId: INSTANCE_ID,
            revision: REVISION,
            status: "unavailable",
            summary: "Unavailable",
          });
          const stale = yield* database.providers.recordObservation({
            providerInstanceId: INSTANCE_ID,
            revision: "stale-revision",
            status: "healthy",
            summary: "Stale",
          });
          return { current, stale };
        }),
      );
      const observation = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{
            readonly instance_revision: string;
            readonly status: string;
            readonly summary: string;
          }>(
            `SELECT instance_revision, status, summary
            FROM provider_instance_observation
            WHERE provider_instance_id = $1`,
            [INSTANCE_ID],
          );
          return result.rows.at(0);
        }),
      );

      expect(writes).toEqual({ current: true, stale: false });
      expect(observation).toEqual({
        instance_revision: REVISION,
        status: "unavailable",
        summary: "Unavailable",
      });
    }),
  ),
);

it.live("removes expired provider operation results in bounded startup batches", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* boundedOperationCleanupTest() {
      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      yield* withPool(databaseUrl, (pool) =>
        Effect.gen(function* insertExpiredOperations() {
          yield* insertFixtureUser(pool, ADMINISTRATOR_ID, "provider-administrator@example.test");
          yield* Effect.promise(() =>
            pool.query(
              `INSERT INTO provider_operation_result (
                administrator_user_id,
                method,
                operation_id,
                request_fingerprint,
                serialized_result,
                completed_at,
                expires_at
              )
              SELECT
                $1,
                'nama.api.v1.ProviderService.UpdateProviderInstance',
                'expired-' || value::text,
                $2,
                '{}'::jsonb,
                transaction_timestamp() - interval '8 days',
                transaction_timestamp() - interval '1 day'
              FROM generate_series(1, 105) AS value`,
              [ADMINISTRATOR_ID, Buffer.alloc(32, 4)],
            ),
          );
        }),
      );

      yield* useDatabase(databaseUrl, productionMigrations, (database) => database.checkReadiness);
      const retained = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{ readonly count: number }>(
            "SELECT count(*)::integer AS count FROM provider_operation_result",
          );
          return result.rows.at(0)?.count;
        }),
      );

      expect(retained).toBe(5);
    }),
  ),
);

it.live("normalizes persistence failures without exposing protected input values", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* redactedFailureTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const protectedConfigurationValue = "non-secret-configuration-sentinel";
      const principalReference = "raw-principal-reference-sentinel";
      const failure = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* rejectUnsafePartition() {
          yield* acceptJellyfinInstallation(database.providers);
          const input = makeInstanceInput(INSTANCE_ID, 1, principalReference);
          return yield* Effect.flip(
            database.providers.createInstance({
              ...input,
              configuration: {
                api_key: protectedConfigurationValue,
                base_url: protectedConfigurationValue,
              },
              operation: {
                ...input.operation,
                canonicalRequest: Buffer.from(
                  JSON.stringify({
                    api_key: SECRET_VALUE,
                    base_url: protectedConfigurationValue,
                    principal: principalReference,
                  }),
                  "utf8",
                ),
              },
            }),
          );
        }),
      );
      const serializedFailure = `${String(failure)} ${JSON.stringify(failure)}`;
      const protectedValues = [
        SECRET_VALUE,
        protectedConfigurationValue,
        principalReference,
        WRONG_MASTER_KEY,
      ];
      const exposedProtectedValue = protectedValues.some((value) =>
        serializedFailure.includes(value),
      );

      expect(failure._tag).toBe("ProviderPersistenceError");
      expect(exposedProtectedValue).toBe(false);
    }),
  ),
);

it.live("derives provider-principal and operation HMACs in separate key domains", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* hmacDomainSeparationTest() {
      yield* initializeProviderDatabase(databaseUrl);
      const sharedHmacInput = "identical-hmac-input";
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* persistComparableHmacInputs() {
          yield* acceptJellyfinInstallation(database.providers, ADMINISTRATOR_ID);
          const input = makeInstanceInput(CREATE_METHOD, 1, sharedHmacInput);
          yield* database.providers.createInstance({
            ...input,
            operation: {
              ...input.operation,
              canonicalRequest: Buffer.from(sharedHmacInput, "utf8"),
              operationId: "domain-separated-operation",
            },
            providerTypeId: ADMINISTRATOR_ID,
          });
        }),
      );
      const separated = yield* withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const result = await pool.query<{ readonly separated: boolean }>(
            `SELECT instance.principal_digest <> operation.request_fingerprint AS separated
            FROM provider_instance AS instance
            INNER JOIN provider_operation_result AS operation
              ON operation.operation_id = 'domain-separated-operation'
            WHERE instance.id = $1`,
            [CREATE_METHOD],
          );
          return result.rows.at(0)?.separated;
        }),
      );

      expect(separated).toBe(true);
    }),
  ),
);
