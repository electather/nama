import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { providerInstance } from "./provider-schema.ts";

const canonicalItem = pgTable(
  "canonical_item",
  {
    contentRating: text("content_rating"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    episodeCount: bigint("episode_count", { mode: "number" }),
    episodeNumber: bigint("episode_number", { mode: "number" }),
    firstReleaseDate: date("first_release_date"),
    genres: text("genres")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    lastReleaseDate: date("last_release_date"),
    originalTitle: text("original_title"),
    releaseDate: date("release_date"),
    releaseYear: bigint("release_year", { mode: "number" }),
    runtimeNanoseconds: integer("runtime_nanoseconds").notNull(),
    runtimeSeconds: bigint("runtime_seconds", { mode: "bigint" }).notNull(),
    seasonCount: bigint("season_count", { mode: "number" }),
    seasonNumber: bigint("season_number", { mode: "number" }),
    studios: text("studios")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    synopsis: text("synopsis"),
    tagline: text("tagline"),
    title: text("title").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("canonical_item_id_kind_unique").on(table.id, table.kind),
    check(
      "canonical_item_kind_check",
      sql`${table.kind} in ('movie', 'show', 'season', 'episode')`,
    ),
    check("canonical_item_title_check", sql`char_length(${table.title}) between 1 and 256`),
    check(
      "canonical_item_original_title_check",
      sql`${table.originalTitle} is null or char_length(${table.originalTitle}) between 1 and 256`,
    ),
    check(
      "canonical_item_synopsis_check",
      sql`${table.synopsis} is null or char_length(${table.synopsis}) <= 16384`,
    ),
    check(
      "canonical_item_tagline_check",
      sql`${table.tagline} is null or char_length(${table.tagline}) between 1 and 256`,
    ),
    check(
      "canonical_item_content_rating_check",
      sql`${table.contentRating} is null or char_length(${table.contentRating}) between 1 and 256`,
    ),
    check(
      "canonical_item_release_year_check",
      sql`${table.releaseYear} is null or ${table.releaseYear} between 0 and 4294967295`,
    ),
    check("canonical_item_runtime_check", sql`${table.runtimeSeconds} >= 0`),
    check(
      "canonical_item_runtime_nanoseconds_check",
      sql`${table.runtimeNanoseconds} between 0 and 999999999`,
    ),
    check("canonical_item_genres_check", sql`cardinality(${table.genres}) <= 50`),
    check("canonical_item_studios_check", sql`cardinality(${table.studios}) <= 50`),
    check(
      "canonical_item_counts_check",
      sql`(${table.seasonCount} is null or ${table.seasonCount} between 0 and 4294967295) and (${table.episodeCount} is null or ${table.episodeCount} between 0 and 4294967295)`,
    ),
    check(
      "canonical_item_kind_details_check",
      sql`(${table.kind} = 'movie' and ${table.firstReleaseDate} is null and ${table.lastReleaseDate} is null and ${table.seasonCount} is null and ${table.episodeCount} is null and ${table.seasonNumber} is null and ${table.episodeNumber} is null)
          or (${table.kind} = 'show' and ${table.releaseDate} is null and ${table.seasonNumber} is null and ${table.episodeNumber} is null)
          or (${table.kind} = 'season' and ${table.releaseDate} is null and ${table.firstReleaseDate} is null and ${table.lastReleaseDate} is null and ${table.seasonCount} is null and ${table.seasonNumber} between 1 and 4294967295 and ${table.episodeNumber} is null)
          or (${table.kind} = 'episode' and ${table.firstReleaseDate} is null and ${table.lastReleaseDate} is null and ${table.seasonCount} is null and ${table.episodeCount} is null and ${table.seasonNumber} between 1 and 4294967295 and ${table.episodeNumber} between 1 and 4294967295)`,
    ),
    check("canonical_item_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

const libraryEntry = pgTable(
  "library_entry",
  {
    canonicalItemId: uuid("canonical_item_id")
      .primaryKey()
      .references(() => canonicalItem.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("library_entry_created_at_index").on(table.createdAt, table.canonicalItemId)],
);

const canonicalHierarchy = pgTable(
  "canonical_hierarchy",
  {
    childItemId: uuid("child_item_id").notNull(),
    childKind: text("child_kind").notNull(),
    parentItemId: uuid("parent_item_id").notNull(),
    parentKind: text("parent_kind").notNull(),
    relationship: text("relationship").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.childItemId, table.relationship] }),
    foreignKey({
      columns: [table.childItemId, table.childKind],
      foreignColumns: [canonicalItem.id, canonicalItem.kind],
      name: "canonical_hierarchy_child_item_kind_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.parentItemId, table.parentKind],
      foreignColumns: [canonicalItem.id, canonicalItem.kind],
      name: "canonical_hierarchy_parent_item_kind_fk",
    }).onDelete("cascade"),
    check(
      "canonical_hierarchy_kind_check",
      sql`(${table.relationship} = 'show' and ${table.childKind} in ('season', 'episode') and ${table.parentKind} = 'show')
          or (${table.relationship} = 'season' and ${table.childKind} = 'episode' and ${table.parentKind} = 'season')`,
    ),
    check(
      "canonical_hierarchy_distinct_items_check",
      sql`${table.childItemId} <> ${table.parentItemId}`,
    ),
    index("canonical_hierarchy_parent_index").on(table.parentItemId, table.relationship),
  ],
);

const providerItemMapping = pgTable(
  "provider_item_mapping",
  {
    canonicalItemId: uuid("canonical_item_id")
      .notNull()
      .references(() => canonicalItem.id, { onDelete: "restrict" }),
    itemReference: text("item_reference").notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenScanRunId: text("last_seen_scan_run_id"),
    providerInstanceId: text("provider_instance_id")
      .notNull()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.providerInstanceId, table.itemReference] }),
    unique("provider_item_mapping_owner_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.canonicalItemId,
    ),
    check(
      "provider_item_mapping_reference_check",
      sql`char_length(${table.itemReference}) between 1 and 256`,
    ),
    check(
      "provider_item_mapping_scan_run_check",
      sql`${table.lastSeenScanRunId} is null or char_length(${table.lastSeenScanRunId}) between 1 and 256`,
    ),
    index("provider_item_mapping_canonical_item_index").on(table.canonicalItemId),
  ],
);

const providerExternalIdentifier = pgTable(
  "provider_external_identifier",
  {
    itemReference: text("item_reference").notNull(),
    namespace: text("namespace").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.providerInstanceId, table.itemReference, table.namespace, table.value],
    }),
    foreignKey({
      columns: [table.providerInstanceId, table.itemReference],
      foreignColumns: [providerItemMapping.providerInstanceId, providerItemMapping.itemReference],
      name: "provider_external_identifier_item_mapping_fk",
    }).onDelete("cascade"),
    check(
      "provider_external_identifier_namespace_check",
      sql`char_length(${table.namespace}) between 1 and 256 and ${table.namespace} = lower(btrim(${table.namespace}))`,
    ),
    check(
      "provider_external_identifier_value_check",
      sql`char_length(${table.value}) between 1 and 256 and ${table.value} = btrim(${table.value})`,
    ),
    index("provider_external_identifier_evidence_index").on(table.namespace, table.value),
  ],
);

const providerItemParentReference = pgTable(
  "provider_item_parent_reference",
  {
    childItemReference: text("child_item_reference").notNull(),
    expectedParentKind: text("expected_parent_kind").notNull(),
    parentItemReference: text("parent_item_reference").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    relationship: text("relationship").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.providerInstanceId, table.childItemReference, table.relationship],
    }),
    foreignKey({
      columns: [table.providerInstanceId, table.childItemReference],
      foreignColumns: [providerItemMapping.providerInstanceId, providerItemMapping.itemReference],
      name: "provider_item_parent_reference_child_mapping_fk",
    }).onDelete("cascade"),
    check(
      "provider_item_parent_reference_parent_check",
      sql`char_length(${table.parentItemReference}) between 1 and 256`,
    ),
    check(
      "provider_item_parent_reference_kind_check",
      sql`(${table.relationship} = 'show' and ${table.expectedParentKind} = 'show') or (${table.relationship} = 'season' and ${table.expectedParentKind} = 'season')`,
    ),
  ],
);
const providerCatalogScanState = pgTable(
  "provider_catalog_scan_state",
  {
    capturedProviderRevision: text("captured_provider_revision").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    coreRunId: text("core_run_id").notNull(),
    lastAcceptedContinuation: text("last_accepted_continuation"),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    providerInstanceId: text("provider_instance_id")
      .primaryKey()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
    safeFailureReason: text("safe_failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "provider_catalog_scan_state_revision_check",
      sql`char_length(${table.capturedProviderRevision}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_run_check",
      sql`char_length(${table.coreRunId}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_status_check",
      sql`${table.status} in ('running', 'succeeded', 'failed', 'paused')`,
    ),
    check(
      "provider_catalog_scan_state_continuation_check",
      sql`${table.lastAcceptedContinuation} is null or char_length(${table.lastAcceptedContinuation}) between 1 and 4096`,
    ),
    check(
      "provider_catalog_scan_state_failure_check",
      sql`${table.safeFailureReason} is null or char_length(${table.safeFailureReason}) between 1 and 256`,
    ),
    check(
      "provider_catalog_scan_state_completion_check",
      sql`(${table.status} = 'running' and ${table.completedAt} is null and ${table.safeFailureReason} is null)
          or (${table.status} = 'succeeded' and ${table.completedAt} is not null and ${table.safeFailureReason} is null and ${table.nextRetryAt} is null)
          or (${table.status} = 'failed' and ${table.completedAt} is not null and ${table.safeFailureReason} is not null)
          or (${table.status} = 'paused' and ${table.completedAt} is not null)`,
    ),
    check(
      "provider_catalog_scan_state_timestamps_check",
      sql`${table.updatedAt} >= ${table.startedAt} and (${table.completedAt} is null or ${table.completedAt} >= ${table.startedAt})`,
    ),
    index("provider_catalog_scan_state_retry_index").on(table.nextRetryAt),
  ],
);
export {
  canonicalHierarchy,
  canonicalItem,
  libraryEntry,
  providerCatalogScanState,
  providerExternalIdentifier,
  providerItemMapping,
  providerItemParentReference,
};
