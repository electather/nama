import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema.ts";
import {
  providerCredential,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerOperationResult,
} from "./provider-schema.ts";

const namaServerState = pgTable(
  "nama_server_state",
  {
    administratorUserId: text("administrator_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    initializedAt: timestamp("initialized_at", { withTimezone: true }),
    key: text("key").primaryKey(),
  },
  (table) => [
    check("nama_server_state_key_check", sql`${table.key} = 'server'`),
    check(
      "nama_server_state_initialization_pair_check",
      sql`(${table.initializedAt} is null) = (${table.administratorUserId} is null)`,
    ),
  ],
);

const authenticationDatabaseSchema = { account, namaServerState, session, user, verification };
const databaseSchema = {
  ...authenticationDatabaseSchema,
  providerCredential,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerOperationResult,
};

export * from "./auth-schema.ts";
export * from "./provider-schema.ts";
export { databaseSchema, namaServerState };
