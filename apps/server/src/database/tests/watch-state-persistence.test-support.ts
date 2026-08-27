import { Effect } from "effect";

import type { WatchStatePersistence } from "../watch-state-persistence.ts";

const unusedWatchStatePersistence: WatchStatePersistence = Object.freeze({
  compareAndCommit: () => Effect.die("unexpected Watch state commit"),
  load: () => Effect.die("unexpected Watch state load"),
});

export { unusedWatchStatePersistence };
