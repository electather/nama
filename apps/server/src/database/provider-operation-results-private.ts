import { and, eq, gt, sql } from "drizzle-orm";
import { Effect } from "effect";

import {
  operationLookupFailure,
  ProviderOperationKeyReused,
} from "./provider-persistence-model-private.ts";
import type {
  ProviderDatabase,
  ProviderOperationKeyReuse,
  ProviderOperationLookup,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
} from "./provider-persistence-model-private.ts";
import { fingerprintOperation, principalDigestsMatch } from "./provider-protection-private.ts";
import { providerOperationResult } from "./provider-schema.ts";
import type { JsonObject } from "./provider-schema.ts";

const FIRST_INDEX = 0;
const OPERATION_CLEANUP_BATCH_SIZE = 100;
const SINGLE_ROW_LIMIT = 1;
const ZERO = 0;

const cleanupExpiredOperationResults = async (database: ProviderDatabase): Promise<void> => {
  await database.execute(sql`
    with expired_provider_operations as (
      select administrator_user_id, method, operation_id
      from ${providerOperationResult}
      where expires_at <= transaction_timestamp()
      order by expires_at, completed_at
      limit ${OPERATION_CLEANUP_BATCH_SIZE}
      for update skip locked
    )
    delete from ${providerOperationResult} as result
    using expired_provider_operations as expired
    where result.administrator_user_id = expired.administrator_user_id
      and result.method = expired.method
      and result.operation_id = expired.operation_id
  `);
};

interface StoredOperationResult {
  readonly requestFingerprint: Buffer;
  readonly serializedResult: JsonObject;
}

const verifyOperationResult = (
  key: Buffer,
  lookup: ProviderOperationLookup,
  row: StoredOperationResult,
): JsonObject => {
  const expectedFingerprint = fingerprintOperation(key, lookup);
  try {
    if (!principalDigestsMatch(expectedFingerprint, row.requestFingerprint)) {
      throw new ProviderOperationKeyReused({});
    }
    return row.serializedResult;
  } finally {
    expectedFingerprint.fill(ZERO);
  }
};

const readOperationResult = (
  context: ProviderPersistenceContext,
  lookup: ProviderOperationLookup,
): Effect.Effect<JsonObject | undefined, ProviderOperationKeyReuse | ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: operationLookupFailure,
    try: async () => {
      const scope = [
        eq(providerOperationResult.administratorUserId, lookup.administratorUserId),
        eq(providerOperationResult.method, lookup.method),
        eq(providerOperationResult.operationId, lookup.operationId),
        gt(providerOperationResult.expiresAt, sql`transaction_timestamp()`),
      ] as const;
      const rows = await context.database
        .select({
          requestFingerprint: providerOperationResult.requestFingerprint,
          serializedResult: providerOperationResult.serializedResult,
        })
        .from(providerOperationResult)
        .where(and(...scope))
        .limit(SINGLE_ROW_LIMIT);
      const row = rows.at(FIRST_INDEX);
      if (row === undefined) {
        return rows[FIRST_INDEX]?.serializedResult;
      }
      return verifyOperationResult(context.keys.operation, lookup, row);
    },
  });

export { cleanupExpiredOperationResults, readOperationResult };
