// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers -- Wrong-master-key PostgreSQL recovery keeps protected creation, restart, and redaction assertions together.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { insertFixtureUser } from "./database-constraint.test-support.ts";
import {
  productionMigrations,
  useConfiguredDatabase,
  useDatabase,
  withPool,
} from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

const ADMINISTRATOR_ID = "pairing-protection-administrator";
const ADMINISTRATOR_EMAIL = "pairing-protection-administrator@example.test";
const WRONG_MASTER_KEY = `base64:${Buffer.alloc(32, 1).toString("base64")}`;

it.live("fails closed and redacts sentinels after a master-key change", () =>
  withIsolatedDatabase((databaseUrl) =>
    Effect.gen(function* wrongMasterKeyTest() {
      const durable = yield* useDatabase(databaseUrl, productionMigrations, (database) =>
        Effect.gen(function* createProtectedPairing() {
          yield* withPool(databaseUrl, (pool) =>
            insertFixtureUser(pool, ADMINISTRATOR_ID, ADMINISTRATOR_EMAIL),
          );
          const pairing = yield* database.pairings.beginPairing({
            displayName: "Protection Sentinel",
          });
          const approvalInput = {
            administratorUserId: ADMINISTRATOR_ID,
            operationId: "pairing-operation-sentinel",
            userCode: pairing.userCode,
          };
          yield* database.pairings.approvePairing(approvalInput);
          yield* withPool(databaseUrl, (pool) =>
            Effect.promise(() =>
              pool.query(
                "UPDATE pairing_request SET next_poll_at = transaction_timestamp() WHERE id = $1",
                [pairing.id],
              ),
            ),
          );
          const status = yield* database.pairings.pollPairing({
            pairingId: pairing.id,
            pollingToken: pairing.pollingToken,
          });
          expect(status.status).toBe("approved");
          if (status.status !== "approved") {
            throw new Error("expected approved Pairing status");
          }
          return { approvalInput, credential: status.credential, pairing };
        }),
      );
      expect(durable).toBeDefined();
      if (durable === undefined) {
        return;
      }

      yield* useConfiguredDatabase(databaseUrl, productionMigrations, {
        masterKey: WRONG_MASTER_KEY,
        use: (database) =>
          Effect.gen(function* rejectWrongKey() {
            const pollingFailure = yield* database.pairings
              .pollPairing({
                pairingId: durable.pairing.id,
                pollingToken: durable.pairing.pollingToken,
              })
              .pipe(Effect.flip);
            expect(pollingFailure).toMatchObject({ _tag: "PairingAuthenticationFailed" });
            expect(
              yield* database.pairings.verifyDeviceCredential(durable.credential),
            ).toBeUndefined();
            const approvalFailure = yield* database.pairings
              .approvePairing(durable.approvalInput)
              .pipe(Effect.flip);
            expect(approvalFailure).toMatchObject({ _tag: "PairingOperationKeyReused" });
            const serializedFailures = JSON.stringify([pollingFailure, approvalFailure]);
            expect(serializedFailures).not.toContain(durable.pairing.userCode);
            expect(serializedFailures).not.toContain(durable.pairing.pollingToken.secret);
            expect(serializedFailures).not.toContain(durable.credential.secret);
            expect(serializedFailures).not.toContain("pairing-operation-sentinel");
            expect(serializedFailures).not.toContain(WRONG_MASTER_KEY);
          }),
      });
    }),
  ),
);
