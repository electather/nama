import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { account, session, user, verification } from "./auth-schema.ts";
import {
  canonicalArtwork,
  canonicalCredit,
  providerArtworkMapping,
} from "./catalog-artwork-schema.ts";
import {
  canonicalHierarchy,
  canonicalItem,
  libraryEntry,
  providerExternalIdentifier,
  providerItemMapping,
  providerItemParentReference,
} from "./catalog-item-schema.ts";
import { providerCatalogScanState } from "./catalog-scan-schema.ts";
import {
  mediaPart,
  mediaSource,
  providerPartMapping,
  providerSourceMapping,
} from "./catalog-source-schema.ts";
import { mediaTrack, providerTrackMapping } from "./catalog-track-schema.ts";
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
  canonicalArtwork,
  canonicalCredit,
  canonicalHierarchy,
  canonicalItem,
  libraryEntry,
  mediaPart,
  mediaSource,
  mediaTrack,
  providerArtworkMapping,
  providerCatalogScanState,
  providerCredential,
  providerExternalIdentifier,
  providerInstallation,
  providerInstance,
  providerInstanceObservation,
  providerItemMapping,
  providerItemParentReference,
  providerOperationResult,
  providerPartMapping,
  providerSourceMapping,
  providerTrackMapping,
};

export * from "./auth-schema.ts";
export * from "./catalog-artwork-schema.ts";
export * from "./catalog-item-schema.ts";
export * from "./catalog-scan-schema.ts";
export * from "./catalog-source-schema.ts";
export * from "./catalog-track-schema.ts";
export * from "./provider-schema.ts";
export { databaseSchema, namaServerState };
