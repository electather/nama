import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { Data } from "effect";

import { user } from "./auth-schema.ts";
import { canonicalItem } from "./catalog-item-schema.ts";
import type { databaseSchema } from "./schema.ts";

type PlayableCanonicalItemKind = "episode" | "movie";
type WatchActivityOrigin =
  | { readonly kind: "nama_playback" }
  | { readonly kind: "nama_watched_status_action" }
  | {
      readonly kind: "provider_replica";
      readonly providerInstanceId: string;
      readonly providerItemReference: string;
    };
type WatchActivityReliability = "heuristic" | "reliable";
type WatchActivitySemantics =
  | "playback_completed"
  | "playback_started"
  | "state_changed"
  | "unknown";

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
    sql`(${table.activityOriginKind} = 'provider_replica') = (${table.activityProviderInstanceId} is not null)`,
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

const FIRST_ARGUMENT = 0;

type WatchStateDatabase = NodePgDatabase<typeof databaseSchema>;
type WatchStateTransaction = Parameters<
  Parameters<WatchStateDatabase["transaction"]>[typeof FIRST_ARGUMENT]
>[typeof FIRST_ARGUMENT];
type WatchStateReader = Pick<WatchStateDatabase, "select">;

interface WatchDuration {
  readonly nanoseconds: number;
  readonly seconds: bigint;
}

interface CanonicalWatchActivity {
  readonly occurredAt: Date;
  readonly origin: WatchActivityOrigin;
  readonly reliability: WatchActivityReliability;
  readonly semantics: WatchActivitySemantics;
}

interface CanonicalWatchStateKey {
  readonly canonicalItemId: string;
  readonly principalId: string;
}

interface CanonicalWatchStateTarget extends CanonicalWatchStateKey {
  readonly activity: CanonicalWatchActivity;
  readonly duration?: WatchDuration | undefined;
  readonly lastSourceId?: string | undefined;
  readonly position?: WatchDuration | undefined;
  readonly watched: boolean;
}

interface CanonicalWatchState extends CanonicalWatchStateTarget {
  readonly committedAt: Date;
  readonly version: bigint;
}

interface CompareAndCommitCanonicalWatchStateInput {
  readonly expectedVersion?: bigint | undefined;
  readonly target: CanonicalWatchStateTarget;
}

type CanonicalWatchStateCommitResult =
  | {
      readonly state: CanonicalWatchState;
      readonly status: "committed";
    }
  | {
      readonly state: CanonicalWatchState | undefined;
      readonly status: "stale";
    };

const taggedError = Data.TaggedError;
const WatchStatePersistenceError = taggedError("WatchStatePersistenceError")<Record<string, never>>;
type WatchStatePersistenceFailure = InstanceType<typeof WatchStatePersistenceError>;

const watchStatePersistenceFailure = (): WatchStatePersistenceFailure =>
  new WatchStatePersistenceError({});

export {
  type CanonicalWatchActivity,
  type CanonicalWatchState,
  type CanonicalWatchStateCommitResult,
  type CanonicalWatchStateKey,
  type CanonicalWatchStateTarget,
  type CompareAndCommitCanonicalWatchStateInput,
  type PlayableCanonicalItemKind,
  type WatchActivityOrigin,
  type WatchActivityReliability,
  type WatchActivitySemantics,
  type WatchDuration,
  type WatchStateDatabase,
  type WatchStatePersistenceFailure,
  type WatchStateReader,
  type WatchStateTransaction,
  canonicalWatchState,
  watchStatePersistenceFailure,
};
