import { sql } from "drizzle-orm";
import {
  bigint,
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
import type { JsonObject, JsonPrimitive, JsonValue } from "./database-types-private.ts";

// fallow-ignore-next-line code-duplication -- Drizzle table declarations keep security constraints adjacent to their columns for migration review.
const providerInstallation = pgTable(
  "provider_installation",
  {
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
    capabilities: jsonb("capabilities").$type<readonly number[]>().notNull(),
    configurationSchema: jsonb("configuration_schema").$type<JsonObject>().notNull(),
    contractMajor: integer("contract_major").notNull(),
    description: text("description").notNull(),
    displayName: text("display_name").notNull(),
    pluginBuildVersion: text("plugin_build_version").notNull(),
    providerTypeId: text("provider_type_id").primaryKey(),
    schemaProfileVersion: integer("schema_profile_version").notNull(),
    schemaRevision: text("schema_revision").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "provider_installation_provider_type_id_check",
      sql`char_length(${table.providerTypeId}) between 1 and 256`,
    ),
    check(
      "provider_installation_display_name_check",
      sql`char_length(${table.displayName}) between 1 and 256`,
    ),
    check(
      "provider_installation_description_check",
      sql`char_length(${table.description}) <= 1024`,
    ),
    check(
      "provider_installation_plugin_build_version_check",
      sql`char_length(${table.pluginBuildVersion}) between 1 and 256`,
    ),
    check("provider_installation_contract_major_check", sql`${table.contractMajor} > 0`),
    check(
      "provider_installation_capabilities_check",
      sql`jsonb_typeof(${table.capabilities}) = 'array' and jsonb_array_length(${table.capabilities}) <= 32`,
    ),
    check(
      "provider_installation_configuration_schema_check",
      sql`jsonb_typeof(${table.configurationSchema}) = 'object' and jsonb_typeof(${table.configurationSchema} -> 'properties') = 'object' and jsonb_array_length(jsonb_path_query_array(${table.configurationSchema} -> 'properties', '$.keyvalue()')) <= 100`,
    ),
    check(
      "provider_installation_schema_profile_version_check",
      sql`${table.schemaProfileVersion} > 0`,
    ),
    check(
      "provider_installation_schema_revision_check",
      sql`char_length(${table.schemaRevision}) between 1 and 256`,
    ),
    check("provider_installation_timestamps_check", sql`${table.updatedAt} >= ${table.acceptedAt}`),
  ],
);

// fallow-ignore-next-line code-duplication -- Drizzle table declarations keep security constraints adjacent to their columns for migration review.
const providerInstance = pgTable(
  "provider_instance",
  {
    configuration: jsonb("configuration").$type<JsonObject>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    displayName: text("display_name").notNull(),
    enabled: boolean("enabled").notNull(),
    id: text("id").primaryKey(),
    principalDigest: bytea("principal_digest").notNull(),
    providerTypeId: text("provider_type_id")
      .notNull()
      .references(() => providerInstallation.providerTypeId, { onDelete: "restrict" }),
    revision: text("revision").notNull(),
    syncPriority: bigint("sync_priority", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("provider_instance_id_check", sql`char_length(${table.id}) between 1 and 256`),
    check(
      "provider_instance_display_name_check",
      sql`char_length(${table.displayName}) between 1 and 256`,
    ),
    check(
      "provider_instance_sync_priority_check",
      sql`${table.syncPriority} between 1 and 4294967295`,
    ),
    check(
      "provider_instance_configuration_check",
      sql`jsonb_typeof(${table.configuration}) = 'object' and jsonb_array_length(jsonb_path_query_array(${table.configuration}, '$.keyvalue()')) <= 100`,
    ),
    check(
      "provider_instance_principal_digest_check",
      sql`octet_length(${table.principalDigest}) = 32`,
    ),
    check(
      "provider_instance_revision_check",
      sql`char_length(${table.revision}) between 1 and 256`,
    ),
    check("provider_instance_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    uniqueIndex("provider_instance_enabled_sync_priority_unique")
      .on(table.syncPriority)
      .where(sql`${table.enabled}`),
  ],
);

// fallow-ignore-next-line code-duplication -- Drizzle table declarations keep security constraints adjacent to their columns for migration review.
const providerCredential = pgTable(
  "provider_credential",
  {
    authenticationTag: bytea("authentication_tag").notNull(),
    ciphertext: bytea("ciphertext").notNull(),
    configurationKey: text("configuration_key").notNull(),
    envelopeVersion: integer("envelope_version").notNull(),
    nonce: bytea("nonce").notNull(),
    providerInstanceId: text("provider_instance_id")
      .notNull()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.providerInstanceId, table.configurationKey] }),
    check(
      "provider_credential_configuration_key_check",
      sql`char_length(${table.configurationKey}) between 1 and 256 and ${table.configurationKey} ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'`,
    ),
    check("provider_credential_envelope_version_check", sql`${table.envelopeVersion} > 0`),
    check("provider_credential_nonce_check", sql`octet_length(${table.nonce}) = 12`),
    check("provider_credential_ciphertext_check", sql`octet_length(${table.ciphertext}) <= 65536`),
    check(
      "provider_credential_authentication_tag_check",
      sql`octet_length(${table.authenticationTag}) = 16`,
    ),
  ],
);

// fallow-ignore-next-line code-duplication -- Drizzle table declarations keep security constraints adjacent to their columns for migration review.
const providerInstanceObservation = pgTable(
  "provider_instance_observation",
  {
    instanceRevision: text("instance_revision").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
    providerInstanceId: text("provider_instance_id")
      .primaryKey()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
  },
  (table) => [
    check(
      "provider_instance_observation_revision_check",
      sql`char_length(${table.instanceRevision}) between 1 and 256`,
    ),
    check(
      "provider_instance_observation_status_check",
      sql`${table.status} in ('healthy', 'unavailable', 'authentication_failed')`,
    ),
    check(
      "provider_instance_observation_summary_check",
      sql`char_length(${table.summary}) <= 1024`,
    ),
  ],
);

// fallow-ignore-next-line code-duplication -- Drizzle table declarations keep security constraints adjacent to their columns for migration review.
const providerOperationResult = pgTable(
  "provider_operation_result",
  {
    administratorUserId: text("administrator_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .default(sql`transaction_timestamp() + interval '7 days'`)
      .notNull(),
    method: text("method").notNull(),
    operationId: text("operation_id").notNull(),
    requestFingerprint: bytea("request_fingerprint").notNull(),
    serializedResult: jsonb("serialized_result").$type<JsonObject>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.administratorUserId, table.method, table.operationId] }),
    check(
      "provider_operation_result_method_check",
      sql`${table.method} in ('nama.api.v1.ProviderService.CreateProviderInstance', 'nama.api.v1.ProviderService.UpdateProviderInstance', 'nama.api.v1.ProviderService.DeleteProviderInstance')`,
    ),
    check(
      "provider_operation_result_operation_id_check",
      sql`char_length(${table.operationId}) between 1 and 256`,
    ),
    check(
      "provider_operation_result_request_fingerprint_check",
      sql`octet_length(${table.requestFingerprint}) = 32`,
    ),
    check(
      "provider_operation_result_serialized_result_check",
      sql`jsonb_typeof(${table.serializedResult}) = 'object'`,
    ),
    check(
      "provider_operation_result_retention_check",
      sql`${table.expiresAt} >= ${table.completedAt} + interval '7 days'`,
    ),
    index("provider_operation_result_expires_at_index").on(table.expiresAt),
  ],
);

export {
  type JsonPrimitive,
  type JsonObject,
  type JsonValue,
  providerCredential,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerOperationResult,
};
