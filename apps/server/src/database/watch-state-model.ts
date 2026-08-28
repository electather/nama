import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";
import { canonicalItem, providerItemMapping } from "./catalog-item-schema.ts";
import type {
  PlayableCanonicalItemKind,
  WatchActivityOrigin,
  WatchActivityReliability,
  WatchActivitySemantics,
} from "./watch-state-types-private.ts";

type WatchActivityOriginColumns = Readonly<{
  activityOriginKind: SQLWrapper;
  activityProviderInstanceId: SQLWrapper;
  activityProviderItemReference: SQLWrapper;
}>;

const activityOriginChecks = (table: WatchActivityOriginColumns) => [
  check(
    "canonical_watch_state_activity_origin_kind_check",
    sql`${table.activityOriginKind} in ('nama_playback', 'nama_watched_status_action', 'provider_replica')`,
  ),
  check(
    "canonical_watch_state_activity_provider_identity_pair_check",
    sql`(${table.activityProviderInstanceId} is null) = (${table.activityProviderItemReference} is null)`,
  ),
  check(
    "canonical_watch_state_activity_provider_identity_origin_check",
    sql`${table.activityOriginKind} = 'provider_replica' or ${table.activityProviderInstanceId} is null`,
  ),
  check(
    "canonical_watch_state_activity_provider_instance_id_check",
    sql`${table.activityProviderInstanceId} is null or char_length(${table.activityProviderInstanceId}) between 1 and 256`,
  ),
  check(
    "canonical_watch_state_activity_provider_item_reference_check",
    sql`${table.activityProviderItemReference} is null or char_length(${table.activityProviderItemReference}) between 1 and 256`,
  ),
];

const canonicalWatchState = pgTable(
  "canonical_watch_state",
  {
    activityOccurredAt: timestamp("activity_occurred_at", { withTimezone: true }).notNull(),
    activityOriginKind: text("activity_origin_kind").$type<WatchActivityOrigin["kind"]>().notNull(),
    activityProviderInstanceId: text("activity_provider_instance_id"),
    activityProviderItemReference: text("activity_provider_item_reference"),
    activityReliability: text("activity_reliability").$type<WatchActivityReliability>().notNull(),
    activitySemantics: text("activity_semantics").$type<WatchActivitySemantics>().notNull(),
    canonicalItemId: uuid("canonical_item_id").notNull(),
    canonicalItemKind: text("canonical_item_kind").$type<PlayableCanonicalItemKind>().notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).defaultNow().notNull(),
    durationNanoseconds: integer("duration_nanoseconds"),
    durationSeconds: bigint("duration_seconds", { mode: "bigint" }),
    lastSourceId: uuid("last_source_id"),
    positionNanoseconds: integer("position_nanoseconds"),
    positionSeconds: bigint("position_seconds", { mode: "bigint" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    version: bigint("version", { mode: "bigint" }).notNull(),
    watched: boolean("watched").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.principalId, table.canonicalItemId] }),
    foreignKey({
      columns: [table.canonicalItemId, table.canonicalItemKind],
      foreignColumns: [canonicalItem.id, canonicalItem.kind],
      name: "canonical_watch_state_playable_item_fk",
    }).onDelete("cascade"),
    check(
      "canonical_watch_state_playable_kind_check",
      sql`${table.canonicalItemKind} in ('movie', 'episode')`,
    ),
    check(
      "canonical_watch_state_position_pair_check",
      sql`(${table.positionSeconds} is null) = (${table.positionNanoseconds} is null)`,
    ),
    check(
      "canonical_watch_state_position_check",
      sql`${table.positionSeconds} is null or (${table.positionSeconds} >= 0 and ${table.positionNanoseconds} between 0 and 999999999)`,
    ),
    check(
      "canonical_watch_state_duration_pair_check",
      sql`(${table.durationSeconds} is null) = (${table.durationNanoseconds} is null)`,
    ),
    check(
      "canonical_watch_state_duration_check",
      sql`${table.durationSeconds} is null or (${table.durationSeconds} >= 0 and ${table.durationNanoseconds} between 0 and 999999999)`,
    ),
    ...activityOriginChecks(table),
    check(
      "canonical_watch_state_activity_reliability_check",
      sql`${table.activityReliability} in ('reliable', 'heuristic')`,
    ),
    check(
      "canonical_watch_state_activity_semantics_check",
      sql`${table.activitySemantics} in ('unknown', 'playback_started', 'playback_completed', 'state_changed')`,
    ),
    check("canonical_watch_state_version_check", sql`${table.version} > 0`),
  ],
);

type ProviderReplicaDurationColumns = Readonly<{
  durationNanoseconds: SQLWrapper;
  durationSeconds: SQLWrapper;
  positionNanoseconds: SQLWrapper;
  positionSeconds: SQLWrapper;
}>;

const providerReplicaDurationChecks = (table: ProviderReplicaDurationColumns) => [
  check(
    "provider_watch_state_replica_position_pair_check",
    sql`(${table.positionSeconds} is null) = (${table.positionNanoseconds} is null)`,
  ),
  check(
    "provider_watch_state_replica_position_check",
    sql`${table.positionSeconds} is null or (${table.positionSeconds} >= 0 and ${table.positionNanoseconds} between 0 and 999999999)`,
  ),
  check(
    "provider_watch_state_replica_duration_pair_check",
    sql`(${table.durationSeconds} is null) = (${table.durationNanoseconds} is null)`,
  ),
  check(
    "provider_watch_state_replica_duration_check",
    sql`${table.durationSeconds} is null or (${table.durationSeconds} >= 0 and ${table.durationNanoseconds} between 0 and 999999999)`,
  ),
];

type ProviderReplicaActivityColumns = Readonly<{
  providerActivityOccurredAt: SQLWrapper;
  providerActivityReliability: SQLWrapper;
  providerActivitySemantics: SQLWrapper;
  providerRevision: SQLWrapper;
}>;

const providerReplicaActivityChecks = (table: ProviderReplicaActivityColumns) => [
  check(
    "provider_watch_state_replica_activity_presence_check",
    sql`(${table.providerActivityOccurredAt} is null) = (${table.providerActivityReliability} is null)
          and (${table.providerActivityOccurredAt} is null) = (${table.providerActivitySemantics} is null)`,
  ),
  check(
    "provider_watch_state_replica_activity_reliability_check",
    sql`${table.providerActivityReliability} is null or ${table.providerActivityReliability} in ('reliable', 'heuristic')`,
  ),
  check(
    "provider_watch_state_replica_activity_semantics_check",
    sql`${table.providerActivitySemantics} is null or ${table.providerActivitySemantics} in ('unknown', 'playback_started', 'playback_completed', 'state_changed')`,
  ),
  check(
    "provider_watch_state_replica_revision_check",
    sql`${table.providerRevision} is null or char_length(${table.providerRevision}) between 1 and 256`,
  ),
];

const providerWatchStateReplica = pgTable(
  "provider_watch_state_replica",
  {
    canonicalItemId: uuid("canonical_item_id").notNull(),
    canonicalItemKind: text("canonical_item_kind").$type<PlayableCanonicalItemKind>().notNull(),
    durationNanoseconds: integer("duration_nanoseconds"),
    durationSeconds: bigint("duration_seconds", { mode: "bigint" }),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    positionNanoseconds: integer("position_nanoseconds"),
    positionSeconds: bigint("position_seconds", { mode: "bigint" }),
    principalId: text("principal_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    providerActivityOccurredAt: timestamp("provider_activity_occurred_at", {
      withTimezone: true,
    }),
    providerActivityReliability: text(
      "provider_activity_reliability",
    ).$type<WatchActivityReliability>(),
    providerActivitySemantics: text("provider_activity_semantics").$type<WatchActivitySemantics>(),
    providerInstanceId: text("provider_instance_id").notNull(),
    providerItemReference: text("provider_item_reference").notNull(),
    providerRevision: text("provider_revision"),
    version: bigint("version", { mode: "bigint" }).notNull(),
    watched: boolean("watched").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.principalId, table.providerInstanceId, table.providerItemReference],
    }),
    foreignKey({
      columns: [table.providerInstanceId, table.providerItemReference, table.canonicalItemId],
      foreignColumns: [
        providerItemMapping.providerInstanceId,
        providerItemMapping.itemReference,
        providerItemMapping.canonicalItemId,
      ],
      name: "provider_watch_state_replica_item_mapping_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.canonicalItemId, table.canonicalItemKind],
      foreignColumns: [canonicalItem.id, canonicalItem.kind],
      name: "provider_watch_state_replica_playable_item_fk",
    }).onDelete("cascade"),
    check(
      "provider_watch_state_replica_playable_kind_check",
      sql`${table.canonicalItemKind} in ('movie', 'episode')`,
    ),
    ...providerReplicaDurationChecks(table),
    ...providerReplicaActivityChecks(table),
    check("provider_watch_state_replica_version_check", sql`${table.version} > 0`),
    index("provider_watch_state_replica_mapping_index").on(
      table.providerInstanceId,
      table.providerItemReference,
      table.canonicalItemId,
    ),
  ],
);

export { canonicalWatchState, providerWatchStateReplica };
