import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { user } from "./auth-schema.ts";

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

export * from "./auth-schema.ts";
export { namaServerState };
