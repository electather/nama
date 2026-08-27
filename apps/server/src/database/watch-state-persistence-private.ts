import { sql } from "drizzle-orm";

import type {
  CanonicalWatchState,
  WatchActivityOrigin,
  WatchDuration,
  canonicalWatchState,
} from "./watch-state-model.ts";

const SQL_NULL = sql`null`;

const storedWatchActivityOrigin = (
  row: typeof canonicalWatchState.$inferSelect,
): WatchActivityOrigin => {
  const { activityOriginKind, activityProviderInstanceId, activityProviderItemReference } = row;
  if (activityOriginKind === "provider_replica") {
    if (activityProviderInstanceId === null || activityProviderItemReference === null) {
      throw new Error("stored Provider replica Activity origin is incomplete");
    }
    return {
      kind: activityOriginKind,
      providerInstanceId: activityProviderInstanceId,
      providerItemReference: activityProviderItemReference,
    };
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

const activityOriginColumns = (origin: WatchActivityOrigin) => {
  if (origin.kind === "provider_replica") {
    return {
      activityOriginKind: origin.kind,
      activityProviderInstanceId: origin.providerInstanceId,
      activityProviderItemReference: origin.providerItemReference,
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

export { activityOriginColumns, storedWatchState };
