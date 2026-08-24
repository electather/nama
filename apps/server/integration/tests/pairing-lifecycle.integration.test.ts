// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers, unicorn/no-null -- Pairing lifecycle scenarios keep ordered PostgreSQL expiry, revocation, and envelope damage transitions visible.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { insertFixtureUser } from "./database-constraint.test-support.ts";
import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { makePollEligible } from "./pairing-persistence.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const ADMINISTRATOR_ID = "pairing-lifecycle-administrator";
const ADMINISTRATOR_EMAIL = "pairing-lifecycle-administrator@example.test";

it.live("expires delivery without invalidating the approved Device credential", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* pairingExpiryTest() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );
        const pairing = yield* database.pairings.beginPairing({ displayName: "Television" });
        const approval = yield* database.pairings.approvePairing({
          administratorUserId: ADMINISTRATOR_ID,
          operationId: "approve-expiring-pairing",
          userCode: pairing.userCode,
        });
        yield* makePollEligible(databaseUrl, pairing.id);
        const approvedStatus = yield* database.pairings.pollPairing({
          pairingId: pairing.id,
          pollingToken: pairing.pollingToken,
        });
        expect(approvedStatus.status).toBe("approved");
        if (approvedStatus.status !== "approved") {
          return;
        }

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request SET expires_at = transaction_timestamp(), next_poll_at = transaction_timestamp(), retained_until = transaction_timestamp() + interval '24 hours' WHERE id = $1",
              [pairing.id],
            ),
          ),
        );
        const expiredStatus = yield* database.pairings.pollPairing({
          pairingId: pairing.id,
          pollingToken: pairing.pollingToken,
        });
        expect(expiredStatus).toEqual({ status: "expired" });
        expect(yield* database.pairings.verifyDeviceCredential(approvedStatus.credential)).toEqual(
          approval.device,
        );

        yield* database.pairings.cleanupExpired;
        const retained = yield* withPool(databaseUrl, (pool) =>
          Effect.promise(async () => {
            const request = await pool.query<{
              readonly delivery_ciphertext: Buffer | null;
            }>("SELECT delivery_ciphertext FROM pairing_request WHERE id = $1", [pairing.id]);
            const credential = await pool.query<{ readonly device_id: string }>(
              "SELECT device_id FROM device_credential WHERE device_id = $1",
              [approval.device.id],
            );
            return { credential: credential.rows, request: request.rows };
          }),
        );
        expect(retained.request).toEqual([{ delivery_ciphertext: null }]);
        expect(retained.credential).toEqual([{ device_id: approval.device.id }]);

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request SET retained_until = transaction_timestamp() WHERE id = $1",
              [pairing.id],
            ),
          ),
        );
        yield* database.pairings.cleanupExpired;
        const remaining = yield* withPool(databaseUrl, (pool) =>
          Effect.promise(async () => {
            const requests = await pool.query<{ readonly count: string }>(
              "SELECT count(*) AS count FROM pairing_request WHERE id = $1",
              [pairing.id],
            );
            const devices = await pool.query<{ readonly count: string }>(
              "SELECT count(*) AS count FROM device WHERE id = $1",
              [approval.device.id],
            );
            return { devices: devices.rows[0]?.count, requests: requests.rows[0]?.count };
          }),
        );
        expect(remaining).toEqual({ devices: "1", requests: "0" });
      }),
    ),
  ),
);

it.live("revokes a Device convergently and removes every credential recovery path", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* deviceRevocationTest() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );
        const pairing = yield* database.pairings.beginPairing({ displayName: "Projector" });
        const approval = yield* database.pairings.approvePairing({
          administratorUserId: ADMINISTRATOR_ID,
          operationId: "approve-revoked-pairing",
          userCode: pairing.userCode,
        });
        yield* makePollEligible(databaseUrl, pairing.id);
        const approvedStatus = yield* database.pairings.pollPairing({
          pairingId: pairing.id,
          pollingToken: pairing.pollingToken,
        });
        expect(approvedStatus.status).toBe("approved");
        if (approvedStatus.status !== "approved") {
          return;
        }

        const firstSeen = yield* database.pairings.recordDeviceSeen(approval.device.id);
        const repeatedSeen = yield* database.pairings.recordDeviceSeen(approval.device.id);
        expect(firstSeen?.lastSeenAt).not.toBeNull();
        expect(repeatedSeen?.lastSeenAt).toEqual(firstSeen?.lastSeenAt);

        const revoked = yield* database.pairings.revokeDevice(approval.device.id);
        const repeated = yield* database.pairings.revokeDevice(approval.device.id);
        expect(revoked).toMatchObject({ revoked: true });
        expect(revoked?.revokedAt).not.toBeNull();
        expect(repeated).toEqual(revoked);
        expect(
          yield* database.pairings.verifyDeviceCredential(approvedStatus.credential),
        ).toBeUndefined();
        const failedPoll = yield* database.pairings
          .pollPairing({ pairingId: pairing.id, pollingToken: pairing.pollingToken })
          .pipe(Effect.flip);
        expect(failedPoll).toMatchObject({ _tag: "PairingPollRateLimited" });
        yield* makePollEligible(databaseUrl, pairing.id);
        const revokedPoll = yield* database.pairings
          .pollPairing({ pairingId: pairing.id, pollingToken: pairing.pollingToken })
          .pipe(Effect.flip);
        expect(revokedPoll).toMatchObject({ _tag: "PairingCredentialUnavailable" });

        const stored = yield* withPool(databaseUrl, (pool) =>
          Effect.promise(async () => {
            const requests = await pool.query<{
              readonly delivery_ciphertext: Buffer | null;
            }>("SELECT delivery_ciphertext FROM pairing_request WHERE id = $1", [pairing.id]);
            const credentials = await pool.query<{ readonly device_id: string }>(
              "SELECT device_id FROM device_credential WHERE device_id = $1",
              [approval.device.id],
            );
            return { credentials: credentials.rows, requests: requests.rows };
          }),
        );
        expect(stored.requests).toEqual([{ delivery_ciphertext: null }]);
        expect(stored.credentials).toHaveLength(0);
      }),
    ),
  ),
);

it.live("fails closed for moved tampered and unsupported delivery envelopes", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, (database) =>
      Effect.gen(function* invalidDeliveryEnvelopeTest() {
        yield* withPool(databaseUrl, (pool) =>
          insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
        );
        const firstPairing = yield* database.pairings.beginPairing({ displayName: "First" });
        const secondPairing = yield* database.pairings.beginPairing({ displayName: "Second" });
        yield* database.pairings.approvePairing({
          administratorUserId: ADMINISTRATOR_ID,
          operationId: "approve-first-envelope",
          userCode: firstPairing.userCode,
        });
        yield* database.pairings.approvePairing({
          administratorUserId: ADMINISTRATOR_ID,
          operationId: "approve-second-envelope",
          userCode: secondPairing.userCode,
        });
        const nonces = yield* withPool(databaseUrl, (pool) =>
          Effect.map(
            Effect.promise(() =>
              pool.query<{ readonly id: string; readonly nonce: Buffer }>(
                "SELECT id, delivery_nonce AS nonce FROM pairing_request ORDER BY id",
              ),
            ),
            (result) => result.rows,
          ),
        );
        expect(nonces).toHaveLength(2);
        expect(nonces[0]?.nonce).not.toEqual(nonces[1]?.nonce);

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request AS target SET delivery_envelope_version = source.delivery_envelope_version, delivery_credential_version = source.delivery_credential_version, delivery_nonce = source.delivery_nonce, delivery_ciphertext = source.delivery_ciphertext, delivery_authentication_tag = source.delivery_authentication_tag, next_poll_at = transaction_timestamp() FROM pairing_request AS source WHERE target.id = $1 AND source.id = $2",
              [secondPairing.id, firstPairing.id],
            ),
          ),
        );
        const moved = yield* database.pairings
          .pollPairing({
            pairingId: secondPairing.id,
            pollingToken: secondPairing.pollingToken,
          })
          .pipe(Effect.flip);
        expect(moved).toMatchObject({ _tag: "PairingCredentialUnavailable" });

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request SET delivery_envelope_version = 2, next_poll_at = transaction_timestamp() WHERE id = $1",
              [firstPairing.id],
            ),
          ),
        );
        const unsupported = yield* database.pairings
          .pollPairing({ pairingId: firstPairing.id, pollingToken: firstPairing.pollingToken })
          .pipe(Effect.flip);
        expect(unsupported).toMatchObject({ _tag: "PairingCredentialUnavailable" });

        yield* withPool(databaseUrl, (pool) =>
          Effect.promise(() =>
            pool.query(
              "UPDATE pairing_request SET delivery_envelope_version = 1, delivery_ciphertext = set_byte(delivery_ciphertext, 0, get_byte(delivery_ciphertext, 0) # 1), next_poll_at = transaction_timestamp() WHERE id = $1",
              [firstPairing.id],
            ),
          ),
        );
        const tampered = yield* database.pairings
          .pollPairing({ pairingId: firstPairing.id, pollingToken: firstPairing.pollingToken })
          .pipe(Effect.flip);
        expect(tampered).toMatchObject({ _tag: "PairingCredentialUnavailable" });
      }),
    ),
  ),
);
