// oxlint-disable eslint/max-lines-per-function, eslint/max-statements, eslint/no-magic-numbers -- Disposable PostgreSQL constraint scenarios keep exact dimensions, faults, and ownership checks together.
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Pool } from "pg";

import { productionMigrations, useDatabase, withPool } from "./database.test-support.ts";
import { withIsolatedDatabase } from "./postgres.test-support.ts";

interface PostgreSqlFailure {
  readonly code: unknown;
  readonly constraint: unknown;
}

const rejectedQuery = async (
  pool: Pool,
  text: string,
  values?: unknown[],
): Promise<PostgreSqlFailure> => {
  try {
    await pool.query(text, values);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      return {
        code: Object.getOwnPropertyDescriptor(error, "code")?.value,
        constraint: Object.getOwnPropertyDescriptor(error, "constraint")?.value,
      };
    }
  }
  throw new Error("expected PostgreSQL query rejection");
};

it.live("enforces Pairing ownership state protected dimensions and cleanup indexes", () =>
  withIsolatedDatabase((databaseUrl) =>
    useDatabase(databaseUrl, productionMigrations, () =>
      withPool(databaseUrl, (pool) =>
        Effect.promise(async () => {
          const invalidRevocation = await rejectedQuery(
            pool,
            "INSERT INTO device (id, display_name, revoked) VALUES ('invalid-device', 'Invalid', true)",
          );
          expect(invalidRevocation).toEqual({
            code: "23514",
            constraint: "device_revocation_state_check",
          });

          await pool.query(
            "INSERT INTO device (id, display_name) VALUES ('constraint-device', 'Constraint Device')",
          );
          const invalidVerifier = await rejectedQuery(
            pool,
            "INSERT INTO device_credential (device_id, verifier, version) VALUES ('constraint-device', $1, 1)",
            [Buffer.alloc(31)],
          );
          expect(invalidVerifier).toEqual({
            code: "23514",
            constraint: "device_credential_verifier_check",
          });

          const incompleteDelivery = await rejectedQuery(
            pool,
            `INSERT INTO pairing_request (
              approved_at, delivery_envelope_version, device_id, display_name, expires_at,
              human_code_digest, human_code_version, id, next_poll_at,
              polling_token_digest, polling_token_version, retained_until, status
            ) VALUES (
              transaction_timestamp(), 1, 'constraint-device', 'Incomplete',
              transaction_timestamp() + interval '10 minutes', $1, 1,
              'incomplete-pairing', transaction_timestamp() + interval '5 seconds', $2,
              1, transaction_timestamp() + interval '24 hours', 'approved'
            )`,
            [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
          );
          expect(incompleteDelivery).toEqual({
            code: "23514",
            constraint: "pairing_request_delivery_completeness_check",
          });

          const missingAdministrator = await rejectedQuery(
            pool,
            `INSERT INTO pairing_approval_result (
              administrator_user_id, device_id, expires_at, method, operation_id,
              pairing_id, request_fingerprint, response
            ) VALUES (
              'missing-administrator', 'constraint-device', transaction_timestamp() + interval '24 hours',
              'nama.api.v1.DeviceService.ApprovePairing', 'constraint-operation',
              'constraint-pairing', $1, '{"id":"constraint-device"}'::jsonb
            )`,
            [Buffer.alloc(32, 3)],
          );
          expect(missingAdministrator).toEqual({
            code: "23503",
            constraint: "pairing_approval_result_administrator_user_id_user_id_fk",
          });

          const indexes = await pool.query<{ readonly indexname: string }>(
            "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename IN ('pairing_request', 'pairing_approval_result', 'device_credential') ORDER BY indexname",
          );
          expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
            expect.arrayContaining([
              "device_credential_version_verifier_unique",
              "pairing_approval_result_expiry_cleanup_index",
              "pairing_request_delivery_cleanup_index",
              "pairing_request_device_id_unique",
              "pairing_request_human_code_digest_unique",
              "pairing_request_polling_token_digest_unique",
              "pairing_request_retention_cleanup_index",
            ]),
          );
        }),
      ),
    ),
  ),
);
