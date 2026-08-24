import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";
import { bytea } from "./database-types-private.ts";
import type { JsonObject } from "./database-types-private.ts";

// fallow-ignore-next-line code-duplication -- Pairing table constraints remain domain-owned and adjacent for migration review.
const device = pgTable(
  "device",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    displayName: text("display_name").notNull(),
    id: text("id").primaryKey(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revoked: boolean("revoked").default(false).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    check("device_id_check", sql`char_length(${table.id}) between 1 and 256`),
    check("device_display_name_check", sql`char_length(${table.displayName}) between 1 and 256`),
    check(
      "device_last_seen_at_check",
      sql`${table.lastSeenAt} is null or ${table.lastSeenAt} >= ${table.createdAt}`,
    ),
    check(
      "device_revocation_state_check",
      sql`${table.revoked} = (${table.revokedAt} is not null)`,
    ),
    check(
      "device_revoked_at_check",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
  ],
);

// fallow-ignore-next-line code-duplication -- Pairing table constraints remain domain-owned and adjacent for migration review.
const deviceCredential = pgTable(
  "device_credential",
  {
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deviceId: text("device_id")
      .primaryKey()
      .references(() => device.id, { onDelete: "cascade" }),
    verifier: bytea("verifier").notNull(),
    version: integer("version").notNull(),
  },
  (table) => [
    check("device_credential_version_check", sql`${table.version} > 0`),
    check("device_credential_verifier_check", sql`octet_length(${table.verifier}) = 32`),
    uniqueIndex("device_credential_version_verifier_unique").on(table.version, table.verifier),
  ],
);

// fallow-ignore-next-line code-duplication -- Pairing table constraints remain domain-owned and adjacent for migration review.
const pairingRequest = pgTable(
  "pairing_request",
  {
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deliveryAuthenticationTag: bytea("delivery_authentication_tag"),
    deliveryCiphertext: bytea("delivery_ciphertext"),
    deliveryCredentialVersion: integer("delivery_credential_version"),
    deliveryEnvelopeVersion: integer("delivery_envelope_version"),
    deliveryNonce: bytea("delivery_nonce"),
    deviceId: text("device_id").references(() => device.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    humanCodeDigest: bytea("human_code_digest").notNull(),
    humanCodeVersion: integer("human_code_version").notNull(),
    id: text("id").primaryKey(),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }).notNull(),
    pollingTokenDigest: bytea("polling_token_digest").notNull(),
    pollingTokenVersion: integer("polling_token_version").notNull(),
    retainedUntil: timestamp("retained_until", { withTimezone: true }).notNull(),
    status: text("status").default("pending").notNull(),
  },
  // oxlint-disable-next-line eslint/max-lines-per-function -- Pairing security constraints remain adjacent to their columns for migration review.
  (table) => [
    check("pairing_request_id_check", sql`char_length(${table.id}) between 1 and 256`),
    check(
      "pairing_request_display_name_check",
      sql`char_length(${table.displayName}) between 1 and 256`,
    ),
    check("pairing_request_human_code_version_check", sql`${table.humanCodeVersion} > 0`),
    check(
      "pairing_request_human_code_digest_check",
      sql`octet_length(${table.humanCodeDigest}) = 32`,
    ),
    check("pairing_request_polling_token_version_check", sql`${table.pollingTokenVersion} > 0`),
    check(
      "pairing_request_polling_token_digest_check",
      sql`octet_length(${table.pollingTokenDigest}) = 32`,
    ),
    check(
      "pairing_request_timestamps_check",
      sql`${table.expiresAt} > ${table.createdAt} and ${table.nextPollAt} > ${table.createdAt} and ${table.nextPollAt} <= ${table.expiresAt} and ${table.retainedUntil} >= ${table.expiresAt}`,
    ),
    check(
      "pairing_request_approval_state_check",
      sql`(${table.status} = 'pending' and ${table.approvedAt} is null and ${table.deviceId} is null) or (${table.status} = 'approved' and ${table.approvedAt} is not null and ${table.approvedAt} < ${table.expiresAt} and ${table.deviceId} is not null)`,
    ),
    check(
      "pairing_request_delivery_completeness_check",
      sql`num_nonnulls(${table.deliveryEnvelopeVersion}, ${table.deliveryCredentialVersion}, ${table.deliveryNonce}, ${table.deliveryCiphertext}, ${table.deliveryAuthenticationTag}) in (0, 5)`,
    ),
    check(
      "pairing_request_delivery_approval_check",
      sql`${table.deliveryEnvelopeVersion} is null or ${table.status} = 'approved'`,
    ),
    check(
      "pairing_request_delivery_envelope_version_check",
      sql`${table.deliveryEnvelopeVersion} is null or ${table.deliveryEnvelopeVersion} > 0`,
    ),
    check(
      "pairing_request_delivery_credential_version_check",
      sql`${table.deliveryCredentialVersion} is null or ${table.deliveryCredentialVersion} > 0`,
    ),
    check(
      "pairing_request_delivery_nonce_check",
      sql`${table.deliveryNonce} is null or octet_length(${table.deliveryNonce}) = 12`,
    ),
    check(
      "pairing_request_delivery_ciphertext_check",
      sql`${table.deliveryCiphertext} is null or octet_length(${table.deliveryCiphertext}) between 1 and 4096`,
    ),
    check(
      "pairing_request_delivery_authentication_tag_check",
      sql`${table.deliveryAuthenticationTag} is null or octet_length(${table.deliveryAuthenticationTag}) = 16`,
    ),
    uniqueIndex("pairing_request_human_code_digest_unique").on(table.humanCodeDigest),
    uniqueIndex("pairing_request_polling_token_digest_unique").on(table.pollingTokenDigest),
    uniqueIndex("pairing_request_device_id_unique")
      .on(table.deviceId)
      .where(sql`${table.deviceId} is not null`),
    index("pairing_request_delivery_cleanup_index")
      .on(table.expiresAt)
      .where(sql`${table.deliveryEnvelopeVersion} is not null`),
    index("pairing_request_retention_cleanup_index").on(table.retainedUntil),
  ],
);

// fallow-ignore-next-line code-duplication -- Pairing table constraints remain domain-owned and adjacent for migration review.
const pairingApprovalResult = pgTable(
  "pairing_approval_result",
  {
    administratorUserId: text("administrator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    method: text("method").notNull(),
    operationId: text("operation_id").notNull(),
    pairingId: text("pairing_id").notNull(),
    requestFingerprint: bytea("request_fingerprint").notNull(),
    response: jsonb("response").$type<JsonObject>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.administratorUserId, table.method, table.operationId] }),
    check(
      "pairing_approval_result_method_check",
      sql`${table.method} = 'nama.api.v1.DeviceService.ApprovePairing'`,
    ),
    check(
      "pairing_approval_result_operation_id_check",
      sql`char_length(${table.operationId}) between 1 and 256`,
    ),
    check(
      "pairing_approval_result_pairing_id_check",
      sql`char_length(${table.pairingId}) between 1 and 256`,
    ),
    check(
      "pairing_approval_result_request_fingerprint_check",
      sql`octet_length(${table.requestFingerprint}) = 32`,
    ),
    check(
      "pairing_approval_result_response_check",
      sql`jsonb_typeof(${table.response}) = 'object' and pg_column_size(${table.response}) <= 8192`,
    ),
    check("pairing_approval_result_timestamps_check", sql`${table.expiresAt} > ${table.createdAt}`),
    index("pairing_approval_result_expiry_cleanup_index").on(table.expiresAt),
  ],
);

export { device, deviceCredential, pairingApprovalResult, pairingRequest };
