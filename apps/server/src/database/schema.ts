import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// oxlint-disable-next-line import/no-namespace -- Better Auth's generated tables must be supplied to Drizzle as one schema object.
import * as authenticationSchema from "./auth-schema.ts";
import {
  canonicalArtwork,
  canonicalCredit,
  providerArtworkMapping,
} from "./catalog-artwork-schema.ts";
import {
  canonicalHierarchy,
  canonicalItem,
  libraryEntry,
  providerCatalogScanState,
  providerExternalIdentifier,
  providerItemMapping,
  providerItemParentReference,
} from "./catalog-item-schema.ts";
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
    administratorUserId: text("administrator_user_id").references(
      () => authenticationSchema.user.id,
      {
        onDelete: "restrict",
      },
    ),
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

const generatedAuthenticationSchema = authenticationSchema;
const authenticationDatabaseSchema = { ...generatedAuthenticationSchema, namaServerState };
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
export * from "./catalog-source-schema.ts";
export * from "./catalog-track-schema.ts";
export * from "./provider-schema.ts";
export { databaseSchema, generatedAuthenticationSchema, namaServerState };
