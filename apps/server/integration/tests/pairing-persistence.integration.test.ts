// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/no-null -- Durable Pairing scenarios keep PostgreSQL transitions, protected dimensions, and exact null state visible.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { insertFixtureUser } from "./database-constraint.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { makePollEligible } from "./pairing-persistence.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const ADMINISTRATOR_ID = "pairing-administrator";
const ADMINISTRATOR_EMAIL = "pairing-administrator@example.test";
const OPERATION_ID = "approve-pairing-operation";
const ONE_ROW = 1;

it.live("persists only protected pairing and Device credential material", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* protectedPairingRoundTrip() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );

        const pairing = yield* database.pairings.beginPairing({
          displayName: "  Living Room  ",
        });
        expect(pairing.displayName).toBe("Living Room");
        expect(pairing.userCode).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/u);
        expect(pairing.pollingToken.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(pairing.pollingToken.version).toBe(1);

        const approval = yield* database.pairings.approvePairing({
          administratorUserId: ADMINISTRATOR_ID,
          operationId: OPERATION_ID,
          userCode: pairing.userCode,
        });
        expect(approval.replayed).toBe(false);
        expect(approval.device).toMatchObject({
          displayName: "Living Room",
          revoked: false,
          revokedAt: null,
        });

        yield* makePollEligible(databaseUrl, pairing.id);
        const status = yield* database.pairings.pollPairing({
          pairingId: pairing.id,
          pollingToken: pairing.pollingToken,
        });
        expect(status.status).toBe("approved");
        if (status.status !== "approved") {
          return;
        }
        expect(status.device).toEqual(approval.device);
        expect(status.credential.version).toBe(1);
        expect(status.credential.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);

        const authenticatedDevice = yield* database.pairings.verifyDeviceCredential(
          status.credential,
        );
        expect(authenticatedDevice).toEqual(approval.device);

        const stored = yield* withPool(databaseUrl, (pool) =>
          Effect.promise(async () => {
            const requests = await pool.query<{
              readonly delivery_ciphertext: Buffer;
              readonly human_code_digest: Buffer;
              readonly polling_token_digest: Buffer;
            }>(
              "SELECT human_code_digest, polling_token_digest, delivery_ciphertext FROM pairing_request WHERE id = $1",
              [pairing.id],
            );
            const credentials = await pool.query<{ readonly verifier: Buffer }>(
              "SELECT verifier FROM device_credential WHERE device_id = $1",
              [approval.device.id],
            );
            return { credentials: credentials.rows, requests: requests.rows };
          }),
        );
        expect(stored.requests).toHaveLength(ONE_ROW);
        expect(stored.credentials).toHaveLength(ONE_ROW);
        expect(stored.requests[0]?.human_code_digest).toHaveLength(32);
        expect(stored.requests[0]?.polling_token_digest).toHaveLength(32);
        expect(stored.credentials[0]?.verifier).toHaveLength(32);
        expect(stored.requests[0]?.delivery_ciphertext).not.toEqual(
          Buffer.from(status.credential.secret, "utf8"),
        );
      }),
    ),
  ),
);

it.live("keeps PostgreSQL polling admission durable without extending early polls", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* durablePollingTest() {
      const pairing = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.pairings.beginPairing({ displayName: "Bedroom" }),
      );
      const readNextPollAt = () =>
        withPool(databaseUrl, (pool) =>
          Effect.map(
            Effect.promise(() =>
              pool.query<{ readonly next_poll_at: Date }>(
                "SELECT next_poll_at FROM pairing_request WHERE id = $1",
                [pairing.id],
              ),
            ),
            (result) => result.rows[0]?.next_poll_at,
          ),
        );
      const initialNextPollAt = yield* readNextPollAt();
      const earlyFailure = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.pairings
          .pollPairing({
            pairingId: pairing.id,
            pollingToken: pairing.pollingToken,
          })
          .pipe(Effect.flip),
      );
      expect(earlyFailure).toMatchObject({
        _tag: "PairingPollRateLimited",
        retryAt: initialNextPollAt,
      });
      expect(yield* readNextPollAt()).toEqual(initialNextPollAt);

      yield* makePollEligible(databaseUrl, pairing.id);
      const pending = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.pairings.pollPairing({
          pairingId: pairing.id,
          pollingToken: pairing.pollingToken,
        }),
      );
      expect(pending).toEqual({ status: "pending" });
      const advancedNextPollAt = yield* readNextPollAt();
      expect(advancedNextPollAt?.valueOf()).toBeGreaterThan(Date.now());

      const restartedFailure = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        database.pairings
          .pollPairing({
            pairingId: pairing.id,
            pollingToken: pairing.pollingToken,
          })
          .pipe(Effect.flip),
      );
      expect(restartedFailure).toMatchObject({
        _tag: "PairingPollRateLimited",
        retryAt: advancedNextPollAt,
      });
      expect(yield* readNextPollAt()).toEqual(advancedNextPollAt);
    }),
  ),
);

it.live("serializes approval and replays only the winning normalized operation", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* concurrentApprovalTest() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );
        const pairing = yield* database.pairings.beginPairing({ displayName: "Kitchen" });
        const request = {
          administratorUserId: ADMINISTRATOR_ID,
          operationId: OPERATION_ID,
          userCode: pairing.userCode,
        };
        const approvals = yield* Effect.all(
          [database.pairings.approvePairing(request), database.pairings.approvePairing(request)],
          { concurrency: "unbounded" },
        );
        const replayOutcomes = approvals
          .map(({ replayed }) => replayed)
          .toSorted((left, right) => Number(left) - Number(right));
        expect(replayOutcomes).toEqual([false, true]);
        expect(approvals[0]?.device).toEqual(approvals[1]?.device);

        const normalizedReplay = yield* database.pairings.approvePairing({
          ...request,
          userCode: pairing.userCode.toLowerCase().replace("-", " "),
        });
        expect(normalizedReplay).toEqual({ device: approvals[0]?.device, replayed: true });

        const anotherOperation = yield* database.pairings
          .approvePairing({ ...request, operationId: "another-operation" })
          .pipe(Effect.flip);
        expect(anotherOperation).toMatchObject({ _tag: "PairingAlreadyApproved" });

        const anotherPairing = yield* database.pairings.beginPairing({ displayName: "Office" });
        const reusedOperation = yield* database.pairings
          .approvePairing({ ...request, userCode: anotherPairing.userCode })
          .pipe(Effect.flip);
        expect(reusedOperation).toMatchObject({ _tag: "PairingOperationKeyReused" });
      }),
    ),
  ),
);
