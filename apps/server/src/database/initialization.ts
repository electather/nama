import { and, eq, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Data, Effect } from "effect";

import { namaServerState, user } from "./schema.ts";

const EXPECTED_SINGLE_ROW_COUNT = 1;
const SERVER_KEY = "server";
const USER_ROW_LIMIT = 2;

const taggedError = Data.TaggedError;
const DatabaseConnectionError = taggedError("DatabaseConnectionError");
const DatabaseIntegrityError = taggedError("DatabaseIntegrityError");

type InitializationMarker = Pick<
  typeof namaServerState.$inferSelect,
  "administratorUserId" | "initializedAt"
>;
type UserRow = Pick<typeof user.$inferSelect, "id">;
type InitializationDecision =
  | { readonly state: "configured" }
  | { readonly state: "setup-eligible" }
  | { readonly administratorUserId: string; readonly state: "repair" };

const integrityFailure = () => new DatabaseIntegrityError(undefined);

const requireInitializationMarker = (
  markerRows: readonly InitializationMarker[],
): InitializationMarker => {
  const [marker] = markerRows;
  if (marker === undefined || markerRows.length !== EXPECTED_SINGLE_ROW_COUNT) {
    throw integrityFailure();
  }
  return marker;
};

const validateInitialization = (marker: InitializationMarker, userRowCount: number): boolean => {
  const hasAdministrator = marker.administratorUserId !== null;
  const hasInitializationTime = marker.initializedAt !== null;
  if (hasAdministrator !== hasInitializationTime || userRowCount > EXPECTED_SINGLE_ROW_COUNT) {
    throw integrityFailure();
  }
  if (hasInitializationTime && userRowCount !== EXPECTED_SINGLE_ROW_COUNT) {
    throw integrityFailure();
  }
  return hasInitializationTime;
};

const decideInitialization = (
  markerRows: readonly InitializationMarker[],
  userRows: readonly UserRow[],
): InitializationDecision => {
  const marker = requireInitializationMarker(markerRows);
  const initializationCompleted = validateInitialization(marker, userRows.length);
  if (initializationCompleted) {
    return { state: "configured" };
  }

  const [administrator] = userRows;
  if (administrator === undefined) {
    return { state: "setup-eligible" };
  }
  return { administratorUserId: administrator.id, state: "repair" };
};

const requireSuccessfulRepair = (repairedRows: readonly unknown[]): void => {
  if (repairedRows.length !== EXPECTED_SINGLE_ROW_COUNT) {
    throw integrityFailure();
  }
};

const classifyInitialization = <Schema extends Record<string, unknown>>(
  database: NodePgDatabase<Schema>,
): Promise<"configured" | "setup-eligible"> =>
  database.transaction(async (transaction) => {
    const markerRows = await transaction
      .select({
        administratorUserId: namaServerState.administratorUserId,
        initializedAt: namaServerState.initializedAt,
      })
      .from(namaServerState)
      .where(eq(namaServerState.key, SERVER_KEY))
      .for("update");
    const userRows = await transaction.select({ id: user.id }).from(user).limit(USER_ROW_LIMIT);
    const decision = decideInitialization(markerRows, userRows);
    if (decision.state !== "repair") {
      return decision.state;
    }

    const repairedRows = await transaction
      .update(namaServerState)
      .set({
        administratorUserId: decision.administratorUserId,
        initializedAt: sql`transaction_timestamp()`,
      })
      .where(
        and(
          eq(namaServerState.key, SERVER_KEY),
          isNull(namaServerState.administratorUserId),
          isNull(namaServerState.initializedAt),
        ),
      )
      .returning({ key: namaServerState.key });
    requireSuccessfulRepair(repairedRows);
    return "configured";
  });

const normalizeReconciliationError = (error: unknown) => {
  if (error instanceof DatabaseIntegrityError) {
    return error;
  }
  return new DatabaseConnectionError(undefined);
};

const reconcileDatabaseInitialization = <Schema extends Record<string, unknown>>(
  database: NodePgDatabase<Schema>,
) =>
  Effect.tryPromise({
    catch: normalizeReconciliationError,
    try: () => classifyInitialization(database),
  });

export { reconcileDatabaseInitialization };
