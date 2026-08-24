// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, eslint/no-underscore-dangle, unicorn/no-null -- Coordination scenarios keep concurrent outcomes, rollback ordering, and exact durable state visible.
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";

import { makePairingPersistence } from "../../src/database/pairing-persistence.ts";
import type {
  PairingPersistence,
  PairingPersistenceOptions,
  PairingValueSource,
} from "../../src/database/pairing-persistence.ts";
import { insertFixtureUser } from "./database-constraint.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const ADMINISTRATOR_ID = "pairing-coordination-administrator";
const ADMINISTRATOR_EMAIL = "pairing-coordination-administrator@example.test";
const MASTER_KEY = `base64:${Buffer.alloc(32).toString("base64")}`;
const MAXIMUM_PAIRINGS = 100;
const LAST_PRECAPACITY_INDEX = 99;

const usePairings = <Result, Failure, Requirements>(
  database: Parameters<typeof makePairingPersistence>[0],
  options: PairingPersistenceOptions,
  use: (pairings: PairingPersistence) => Effect.Effect<Result, Failure, Requirements>,
) =>
  Effect.acquireUseRelease(
    makePairingPersistence(database, Redacted.make(MASTER_KEY), options),
    (owner) => use(owner.service),
    (owner) => owner.close,
  );

it.live("retries a human-code digest collision without exposing the occupied code", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) => {
      let pairingIndex = 0;
      let secretIndex = 0;
      const codes = ["22222222", "22222222", "33333333"];
      const values: PairingValueSource = Object.freeze({
        deviceId: () => "unused-device-id",
        humanCode: () => codes.shift() ?? "44444444",
        pairingId: () => `pairing-${pairingIndex++}`,
        secret: () => `${"A".repeat(42)}${secretIndex++}`,
      });
      return usePairings(database.authentication.database, { values }, (pairings) =>
        Effect.gen(function* collisionRetryTest() {
          const first = yield* pairings.beginPairing({ displayName: "First" });
          const second = yield* pairings.beginPairing({ displayName: "Second" });
          expect(first.userCode).toBe("2222-2222");
          expect(second.userCode).toBe("3333-3333");
          const stored = yield* withPool(databaseUrl, (pool) =>
            Effect.map(
              Effect.promise(() =>
                pool.query<{ readonly human_code_digest: Buffer }>(
                  "SELECT human_code_digest FROM pairing_request ORDER BY id",
                ),
              ),
              (result) => result.rows,
            ),
          );
          expect(stored).toHaveLength(2);
          expect(stored[0]?.human_code_digest).not.toEqual(stored[1]?.human_code_digest);
        }),
      );
    }),
  ),
);

it.live("serializes the installation-wide unexpired Pairing limit with cleanup", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* pairingCapacityTest() {
        yield* Effect.forEach(
          Array.from({ length: LAST_PRECAPACITY_INDEX }),
          (_unusedValue, index) =>
            database.pairings.beginPairing({ displayName: `Device ${index}` }),
          { concurrency: 1, discard: true },
        );
        const contenders = awaitPairingOutcomes(database.pairings);
        const outcomes = yield* contenders;
        expect(outcomes.toSorted()).toEqual(["accepted", "capacity"]);
        const countPairings = () =>
          withPool(databaseUrl, (pool) =>
            Effect.map(
              Effect.promise(() =>
                pool.query<{ readonly count: string }>(
                  "SELECT count(*) AS count FROM pairing_request WHERE expires_at > transaction_timestamp()",
                ),
              ),
              (result) => result.rows[0]?.count,
            ),
          );
        expect(yield* countPairings()).toBe(String(MAXIMUM_PAIRINGS));

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request SET expires_at = transaction_timestamp(), next_poll_at = transaction_timestamp(), retained_until = transaction_timestamp() WHERE id = (SELECT id FROM pairing_request ORDER BY id LIMIT 1)",
            ),
          ),
        );
        yield* database.pairings.beginPairing({ displayName: "Replacement" });
        expect(yield* countPairings()).toBe(String(MAXIMUM_PAIRINGS));
      }),
    ),
  ),
);

const awaitPairingOutcomes = (pairings: PairingPersistence) =>
  Effect.all(
    ["First contender", "Second contender"].map((displayName) =>
      pairings.beginPairing({ displayName }).pipe(
        Effect.match({
          onFailure: (failure) => {
            if (failure._tag === "PairingCapacityReached") {
              return "capacity";
            }
            return "unexpected";
          },
          onSuccess: () => "accepted",
        }),
      ),
    ),
    { concurrency: "unbounded" },
  );

it.live("rolls back approval and recovers the same operation after the final write fails", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* approvalRollbackTest() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );
        const pairing = yield* database.pairings.beginPairing({ displayName: "Rollback" });
        const request = {
          administratorUserId: ADMINISTRATOR_ID,
          operationId: "rollback-operation",
          userCode: pairing.userCode,
        };
        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(`
              CREATE FUNCTION reject_pairing_result() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                RAISE EXCEPTION 'pairing result rejected';
              END
              $$;
              CREATE TRIGGER reject_pairing_result
              BEFORE INSERT ON pairing_approval_result
              FOR EACH ROW EXECUTE FUNCTION reject_pairing_result();
            `),
          ),
        );
        const failure = yield* database.pairings.approvePairing(request).pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "PairingPersistenceError" });
        const rolledBack = yield* withPool(databaseUrl, (pool) =>
          Effect.promise(async () => {
            const devices = await pool.query<{ readonly count: string }>(
              "SELECT count(*) AS count FROM device",
            );
            const requestState = await pool.query<{
              readonly delivery_ciphertext: Buffer | null;
              readonly status: string;
            }>("SELECT status, delivery_ciphertext FROM pairing_request WHERE id = $1", [
              pairing.id,
            ]);
            return { devices: devices.rows[0]?.count, request: requestState.rows[0] };
          }),
        );
        expect(rolledBack).toEqual({
          devices: "0",
          request: { delivery_ciphertext: null, status: "pending" },
        });
        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(`
              DROP TRIGGER reject_pairing_result ON pairing_approval_result;
              DROP FUNCTION reject_pairing_result();
            `),
          ),
        );
        const recovered = yield* database.pairings.approvePairing(request);
        expect(recovered.replayed).toBe(false);
      }),
    ),
  ),
);

it.live("arbitrates concurrent approvals and recovers a committed lost response", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* approvalAmbiguityTest() {
      const committed = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* concurrentApproval() {
          yield* withPool(databaseUrl, (pool) =>
            insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
          );
          const pairing = yield* database.pairings.beginPairing({ displayName: "Concurrent" });
          const firstRequest = {
            administratorUserId: ADMINISTRATOR_ID,
            operationId: "operation-a",
            userCode: pairing.userCode,
          };
          const secondRequest = { ...firstRequest, operationId: "operation-b" };
          const [firstExit, secondExit] = yield* Effect.all(
            [
              database.pairings.approvePairing(firstRequest).pipe(Effect.exit),
              database.pairings.approvePairing(secondRequest).pipe(Effect.exit),
            ],
            { concurrency: "unbounded" },
          );
          const exits = [firstExit, secondExit];
          expect(exits.filter((exit) => Exit.isSuccess(exit))).toHaveLength(1);
          expect(exits.filter((exit) => Exit.isFailure(exit))).toHaveLength(1);
          const counts = yield* withPool(databaseUrl, (pool) =>
            Effect.promise(async () => {
              const devices = await pool.query<{ readonly count: string }>(
                "SELECT count(*) AS count FROM device",
              );
              const credentials = await pool.query<{ readonly count: string }>(
                "SELECT count(*) AS count FROM device_credential",
              );
              const results = await pool.query<{ readonly count: string }>(
                "SELECT count(*) AS count FROM pairing_approval_result",
              );
              return [devices.rows[0]?.count, credentials.rows[0]?.count, results.rows[0]?.count];
            }),
          );
          expect(counts).toEqual(["1", "1", "1"]);
          if (Exit.isSuccess(firstExit)) {
            return { approval: firstExit.value, request: firstRequest };
          }
          if (Exit.isSuccess(secondExit)) {
            return { approval: secondExit.value, request: secondRequest };
          }
          return false;
        }),
      );
      expect(committed).not.toBe(false);
      if (committed === false) {
        return;
      }
      const replay = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.pairings.approvePairing(committed.request),
      );
      expect(replay).toEqual({ device: committed.approval.device, replayed: true });
    }),
  ),
);

it.live("runs bounded startup cleanup and continues cleanup on its interval", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* boundedAndPeriodicCleanupTest() {
      yield* useDatabase(databaseUrl, productionMigrations, () => Effect.void);
      yield* withPool(databaseUrl, (pool) =>
        Effect.promise(() =>
          pool.query(`
            INSERT INTO pairing_request (
              created_at, display_name, expires_at, human_code_digest, human_code_version,
              id, next_poll_at, polling_token_digest, polling_token_version, retained_until
            )
            SELECT
              transaction_timestamp() - interval '26 hours',
              'Expired',
              transaction_timestamp() - interval '25 hours',
              decode(lpad(to_hex(value), 64, '0'), 'hex'),
              1,
              'expired-' || value,
              transaction_timestamp() - interval '25 hours',
              decode(lpad(to_hex(value + 1000), 64, '0'), 'hex'),
              1,
              transaction_timestamp() - interval '1 hour'
            FROM generate_series(1, 101) AS value
          `),
        ),
      );
      yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* startupAndIntervalCleanup() {
          const afterStartup = yield* withPool(databaseUrl, (pool) =>
            Effect.map(
              Effect.promise(() =>
                pool.query<{ readonly count: string }>(
                  "SELECT count(*) AS count FROM pairing_request",
                ),
              ),
              (result) => result.rows[0]?.count,
            ),
          );
          expect(afterStartup).toBe("1");
          yield* usePairings(
            database.authentication.database,
            { cleanupIntervalMilliseconds: 20 },
            () => Effect.sleep("100 millis"),
          );
          const afterInterval = yield* withPool(databaseUrl, (pool) =>
            Effect.map(
              Effect.promise(() =>
                pool.query<{ readonly count: string }>(
                  "SELECT count(*) AS count FROM pairing_request",
                ),
              ),
              (result) => result.rows[0]?.count,
            ),
          );
          expect(afterInterval).toBe("0");
          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query(
                `INSERT INTO pairing_request (
                  created_at, display_name, expires_at, human_code_digest, human_code_version,
                  id, next_poll_at, polling_token_digest, polling_token_version, retained_until
                ) VALUES (
                  transaction_timestamp() - interval '2 hours', 'After close',
                  transaction_timestamp() - interval '1 hour', $1, 1, 'after-close',
                  transaction_timestamp() - interval '1 hour', $2, 1,
                  transaction_timestamp() - interval '1 minute'
                )`,
                [Buffer.alloc(32, 7), Buffer.alloc(32, 8)],
              ),
            ),
          );
          yield* Effect.sleep("100 millis");
          const afterClose = yield* withPool(databaseUrl, (pool) =>
            Effect.map(
              Effect.promise(() =>
                pool.query<{ readonly count: string }>(
                  "SELECT count(*) AS count FROM pairing_request",
                ),
              ),
              (result) => result.rows[0]?.count,
            ),
          );
          expect(afterClose).toBe("1");
        }),
      );
    }),
  ),
);
