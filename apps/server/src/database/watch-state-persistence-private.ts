import { sql } from "drizzle-orm";

import type { canonicalWatchState, providerWatchStateReplica } from "./watch-state-model.ts";
import type {
  CanonicalWatchState,
  CanonicalWatchStateTarget,
  ProviderReplica,
  ProviderWatchActivity,
  WatchActivityOrigin,
  WatchDuration,
} from "./watch-state-types-private.ts";

const SQL_NULL = sql`null`;

const storedProviderReplicaActivityOrigin = (
  providerInstanceId: string | null,
  providerItemReference: string | null,
): WatchActivityOrigin => {
  if (providerInstanceId === null && providerItemReference === null) {
    return { detached: true, kind: "provider_replica" };
  }
  if (providerInstanceId === null || providerItemReference === null) {
    throw new Error("stored Provider replica Activity origin is incomplete");
  }
  return {
    exactProviderReplica: {
      providerInstanceId,
      providerItemReference,
    },
    kind: "provider_replica",
  };
};

const storedWatchActivityOrigin = (
  row: typeof canonicalWatchState.$inferSelect,
): WatchActivityOrigin => {
  const { activityOriginKind, activityProviderInstanceId, activityProviderItemReference } = row;
  if (activityOriginKind === "provider_replica") {
    return storedProviderReplicaActivityOrigin(
      activityProviderInstanceId,
      activityProviderItemReference,
    );
  }
  if (activityProviderInstanceId !== null || activityProviderItemReference !== null) {
    throw new Error("stored Nama Activity origin has Provider replica identity");
  }
  if (
    activityOriginKind !== "nama_playback" &&
    activityOriginKind !== "nama_watched_status_action"
  ) {
    throw new Error("stored Watch Activity origin is invalid");
  }
  return { kind: activityOriginKind };
};

const activityOriginColumns = (origin: CanonicalWatchStateTarget["activity"]["origin"]) => {
  if (origin.kind === "provider_replica") {
    return {
      activityOriginKind: origin.kind,
      activityProviderInstanceId: origin.exactProviderReplica.providerInstanceId,
      activityProviderItemReference: origin.exactProviderReplica.providerItemReference,
    };
  }
  return {
    activityOriginKind: origin.kind,
    activityProviderInstanceId: SQL_NULL,
    activityProviderItemReference: SQL_NULL,
  };
};

const storedDuration = (
  seconds: bigint | null,
  nanoseconds: number | null,
): WatchDuration | undefined => {
  if (seconds === null) {
    if (nanoseconds !== null) {
      throw new Error("stored Watch duration has nanoseconds without seconds");
    }
    return undefined;
  }
  if (nanoseconds === null) {
    throw new Error("stored Watch duration has seconds without nanoseconds");
  }
  return { nanoseconds, seconds };
};

const storedProviderActivity = (
  row: typeof providerWatchStateReplica.$inferSelect,
): ProviderWatchActivity | undefined => {
  const { providerActivityOccurredAt, providerActivityReliability, providerActivitySemantics } =
    row;
  if (providerActivityOccurredAt === null) {
    if (providerActivityReliability !== null || providerActivitySemantics !== null) {
      throw new Error("stored Provider replica Activity is incomplete");
    }
    return undefined;
  }
  if (providerActivityReliability === null || providerActivitySemantics === null) {
    throw new Error("stored Provider replica Activity is incomplete");
  }
  return {
    occurredAt: providerActivityOccurredAt,
    reliability: providerActivityReliability,
    semantics: providerActivitySemantics,
  };
};

const providerActivityColumns = (activity: ProviderWatchActivity | undefined) => {
  if (activity === undefined) {
    return {
      providerActivityOccurredAt: SQL_NULL,
      providerActivityReliability: SQL_NULL,
      providerActivitySemantics: SQL_NULL,
    };
  }
  return {
    providerActivityOccurredAt: activity.occurredAt,
    providerActivityReliability: activity.reliability,
    providerActivitySemantics: activity.semantics,
  };
};

const storedProviderReplica = (
  row: typeof providerWatchStateReplica.$inferSelect,
): ProviderReplica => ({
  canonicalItemId: row.canonicalItemId,
  duration: storedDuration(row.durationSeconds, row.durationNanoseconds),
  observedAt: row.observedAt,
  position: storedDuration(row.positionSeconds, row.positionNanoseconds),
  principalId: row.principalId,
  providerActivity: storedProviderActivity(row),
  providerInstanceId: row.providerInstanceId,
  providerItemReference: row.providerItemReference,
  providerRevision: row.providerRevision ?? undefined,
  version: row.version,
  watched: row.watched,
});

const storedWatchState = (row: typeof canonicalWatchState.$inferSelect): CanonicalWatchState => ({
  activity: {
    occurredAt: row.activityOccurredAt,
    origin: storedWatchActivityOrigin(row),
    reliability: row.activityReliability,
    semantics: row.activitySemantics,
  },
  canonicalItemId: row.canonicalItemId,
  committedAt: row.committedAt,
  duration: storedDuration(row.durationSeconds, row.durationNanoseconds),
  lastSourceId: row.lastSourceId ?? undefined,
  position: storedDuration(row.positionSeconds, row.positionNanoseconds),
  principalId: row.principalId,
  version: row.version,
  watched: row.watched,
});

export { activityOriginColumns, providerActivityColumns, storedProviderReplica, storedWatchState };
