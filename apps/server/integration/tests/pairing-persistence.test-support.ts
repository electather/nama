import { Effect } from "effect";

import { withPool } from "./database.test-support.ts";

const makePollEligible = (databaseUrl: string, pairingId: string) =>
  withPool(databaseUrl, (pool) =>
    Effect.promise(() =>
      pool.query(
        "UPDATE pairing_request SET next_poll_at = transaction_timestamp() WHERE id = $1",
        [pairingId],
      ),
    ),
  );

export { makePollEligible };
