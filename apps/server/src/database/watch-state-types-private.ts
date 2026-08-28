import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data } from "effect";

import type { databaseSchema } from "./schema.ts";

type PlayableCanonicalItemKind = "episode" | "movie";
type WatchActivityOriginTarget =
  | { readonly kind: "nama_playback" }
  | { readonly kind: "nama_watched_status_action" }
  | Readonly<{
      readonly exactProviderReplica: Readonly<{
        readonly providerInstanceId: string;
        readonly providerItemReference: string;
      }>;
      readonly kind: "provider_replica";
    }>;
type WatchActivityOrigin =
  | WatchActivityOriginTarget
  | {
      readonly kind: "provider_replica";
    };
type WatchActivityReliability = "heuristic" | "reliable";
type WatchActivitySemantics =
  | "playback_completed"
  | "playback_started"
  | "state_changed"
  | "unknown";

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

interface CanonicalWatchActivityTarget {
  readonly occurredAt: Date;
  readonly origin: WatchActivityOriginTarget;
  readonly reliability: WatchActivityReliability;
  readonly semantics: WatchActivitySemantics;
}

interface CanonicalWatchStateKey {
  readonly canonicalItemId: string;
  readonly principalId: string;
}

interface CanonicalWatchStateTarget extends CanonicalWatchStateKey {
  readonly activity: CanonicalWatchActivityTarget;
  readonly duration?: WatchDuration | undefined;
  readonly lastSourceId?: string | undefined;
  readonly position?: WatchDuration | undefined;
  readonly watched: boolean;
}

interface CanonicalWatchState extends CanonicalWatchStateKey {
  readonly activity: CanonicalWatchActivity;
  readonly committedAt: Date;
  readonly duration?: WatchDuration | undefined;
  readonly lastSourceId?: string | undefined;
  readonly position?: WatchDuration | undefined;
  readonly version: bigint;
  readonly watched: boolean;
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

interface ProviderWatchActivity {
  readonly occurredAt: Date;
  readonly reliability: WatchActivityReliability;
  readonly semantics: WatchActivitySemantics;
}

interface ProviderReplicaKey {
  readonly principalId: string;
  readonly providerInstanceId: string;
  readonly providerItemReference: string;
}

interface ProviderReplicaTarget extends ProviderReplicaKey {
  readonly duration?: WatchDuration | undefined;
  readonly observedAt: Date;
  readonly position?: WatchDuration | undefined;
  readonly providerActivity?: ProviderWatchActivity | undefined;
  readonly providerRevision?: string | undefined;
  readonly watched: boolean;
}

interface ProviderReplica extends ProviderReplicaTarget {
  readonly canonicalItemId: string;
  readonly version: bigint;
}

interface CompareAndCommitProviderReplicaInput {
  readonly canonicalTarget?: CanonicalWatchStateTarget | undefined;
  readonly expectedCanonicalVersion?: bigint | undefined;
  readonly expectedReplicaVersion?: bigint | undefined;
  readonly replicaTarget: ProviderReplicaTarget;
}

type ProviderReplicaCommitResult =
  | {
      readonly canonicalState: CanonicalWatchState | undefined;
      readonly providerReplica: ProviderReplica;
      readonly status: "committed";
    }
  | {
      readonly canonicalState: CanonicalWatchState | undefined;
      readonly providerReplica: ProviderReplica | undefined;
      readonly status: "stale";
    };

const taggedError = Data.TaggedError;
const WatchStatePersistenceError = taggedError("WatchStatePersistenceError")<Record<string, never>>;
type WatchStatePersistenceFailure = InstanceType<typeof WatchStatePersistenceError>;

const watchStatePersistenceFailure = (): WatchStatePersistenceFailure =>
  new WatchStatePersistenceError({});

export {
  type CanonicalWatchActivity,
  type CanonicalWatchActivityTarget,
  type CanonicalWatchState,
  type CanonicalWatchStateCommitResult,
  type CanonicalWatchStateKey,
  type CanonicalWatchStateTarget,
  type CompareAndCommitCanonicalWatchStateInput,
  type CompareAndCommitProviderReplicaInput,
  type PlayableCanonicalItemKind,
  type ProviderReplica,
  type ProviderReplicaCommitResult,
  type ProviderReplicaKey,
  type ProviderReplicaTarget,
  type ProviderWatchActivity,
  type WatchActivityOrigin,
  type WatchActivityOriginTarget,
  type WatchActivityReliability,
  type WatchActivitySemantics,
  type WatchDuration,
  type WatchStateDatabase,
  type WatchStatePersistenceFailure,
  type WatchStateReader,
  type WatchStateTransaction,
  watchStatePersistenceFailure,
};
