import { Effect } from "effect";

import type { WatchStatePersistence } from "../watch-state-persistence.ts";

const unusedWatchStatePersistence: WatchStatePersistence = Object.freeze({
  compareAndCommitCanonicalWatchState: () => Effect.die("unexpected Watch state commit"),
  compareAndCommitProviderReplica: () => Effect.die("unexpected Provider replica commit"),
  loadCanonicalWatchState: () => Effect.die("unexpected Watch state load"),
  loadProviderReplica: () => Effect.die("unexpected Provider replica load"),
});

export { unusedWatchStatePersistence };
