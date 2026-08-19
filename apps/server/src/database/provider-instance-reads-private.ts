import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import { persistenceFailure } from "./provider-persistence-model-private.ts";
import type {
  ProviderDatabase,
  ProviderInstanceListInput,
  ProviderInstanceRecord,
  ProviderPersistenceContext,
  ProviderPersistenceFailure,
} from "./provider-persistence-model-private.ts";
import {
  providerCredential,
  providerInstance,
  providerInstanceObservation,
} from "./provider-schema.ts";

const FIRST_ROW = 0;
const MAXIMUM_INSTANCE_READ = 101;
const SINGLE_ROW_LIMIT = 1;
const sortableCreatedAt = sql`date_trunc('milliseconds', ${providerInstance.createdAt})`;

const instanceSelection = Object.freeze({
  configuration: providerInstance.configuration,
  createdAt: providerInstance.createdAt,
  displayName: providerInstance.displayName,
  enabled: providerInstance.enabled,
  id: providerInstance.id,
  observationStatus: providerInstanceObservation.status,
  observationSummary: providerInstanceObservation.summary,
  providerTypeId: providerInstance.providerTypeId,
  revision: providerInstance.revision,
  syncPriority: providerInstance.syncPriority,
  updatedAt: providerInstance.updatedAt,
});

type SelectedInstance = Readonly<{
  configuration: ProviderInstanceRecord["configuration"];
  createdAt: Date;
  displayName: string;
  enabled: boolean;
  id: string;
  observationStatus: string;
  observationSummary: string;
  providerTypeId: string;
  revision: string;
  syncPriority: number;
  updatedAt: Date;
}>;

const configuredSecretsByInstance = async (
  database: ProviderDatabase,
  providerInstanceIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> => {
  if (providerInstanceIds.length === FIRST_ROW) {
    return new Map();
  }
  const rows = await database
    .select({
      configurationKey: providerCredential.configurationKey,
      providerInstanceId: providerCredential.providerInstanceId,
    })
    .from(providerCredential)
    .where(inArray(providerCredential.providerInstanceId, [...providerInstanceIds]))
    .orderBy(asc(providerCredential.providerInstanceId), asc(providerCredential.configurationKey));
  const result = new Map<string, string[]>();
  for (const row of rows) {
    const keys = result.get(row.providerInstanceId);
    if (keys === undefined) {
      result.set(row.providerInstanceId, [row.configurationKey]);
    } else {
      keys.push(row.configurationKey);
    }
  }
  return result;
};

const recordsFromRows = async (
  context: ProviderPersistenceContext,
  rows: readonly SelectedInstance[],
): Promise<readonly ProviderInstanceRecord[]> => {
  const configuredSecrets = await configuredSecretsByInstance(
    context.database,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    if (
      row.observationStatus !== "authentication_failed" &&
      row.observationStatus !== "healthy" &&
      row.observationStatus !== "unavailable"
    ) {
      throw new Error("invalid provider observation status");
    }
    return {
      configuration: row.configuration,
      configuredSecretKeys: configuredSecrets.get(row.id) ?? [],
      createdAt: row.createdAt,
      credentialsAvailable: !context.unavailableInstances.has(row.id),
      displayName: row.displayName,
      enabled: row.enabled,
      id: row.id,
      observation: {
        status: row.observationStatus,
        summary: row.observationSummary,
      },
      providerTypeId: row.providerTypeId,
      revision: row.revision,
      syncPriority: row.syncPriority,
      updatedAt: row.updatedAt,
    };
  });
};

const validatedListInput = (input: ProviderInstanceListInput): void => {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= FIRST_ROW ||
    input.limit > MAXIMUM_INSTANCE_READ ||
    (input.after !== undefined &&
      (input.after.providerInstanceId.length === FIRST_ROW ||
        !Number.isFinite(input.after.createdAt.getTime())))
  ) {
    throw new RangeError("invalid provider instance read");
  }
};

const listInstances = (
  context: ProviderPersistenceContext,
  input: ProviderInstanceListInput,
): Effect.Effect<readonly ProviderInstanceRecord[], ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      validatedListInput(input);
      const query = context.database
        .select(instanceSelection)
        .from(providerInstance)
        .innerJoin(
          providerInstanceObservation,
          eq(providerInstanceObservation.providerInstanceId, providerInstance.id),
        )
        .orderBy(asc(sortableCreatedAt), asc(providerInstance.id))
        .limit(input.limit);
      if (input.after === undefined) {
        const rows = await query;
        return recordsFromRows(context, rows);
      }
      const sameCreatedAt = and(
        eq(sortableCreatedAt, input.after.createdAt),
        gt(providerInstance.id, input.after.providerInstanceId),
      );
      const afterCursor = or(gt(sortableCreatedAt, input.after.createdAt), sameCreatedAt);
      const rows = await query.where(afterCursor);
      return recordsFromRows(context, rows);
    },
  });

const loadInstanceRecord = (
  context: ProviderPersistenceContext,
  providerInstanceId: string,
): Effect.Effect<ProviderInstanceRecord | undefined, ProviderPersistenceFailure> =>
  Effect.tryPromise({
    catch: persistenceFailure,
    try: async () => {
      const rows = await context.database
        .select(instanceSelection)
        .from(providerInstance)
        .innerJoin(
          providerInstanceObservation,
          eq(providerInstanceObservation.providerInstanceId, providerInstance.id),
        )
        .where(eq(providerInstance.id, providerInstanceId))
        .limit(SINGLE_ROW_LIMIT);
      const records = await recordsFromRows(context, rows);
      return records.at(FIRST_ROW);
    },
  });

export { listInstances, loadInstanceRecord };
