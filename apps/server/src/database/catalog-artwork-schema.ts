import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { canonicalItem, providerItemMapping } from "./catalog-item-schema.ts";

const providerArtworkMapping = pgTable(
  "provider_artwork_mapping",
  {
    artworkId: uuid("artwork_id").notNull(),
    artworkReference: text("artwork_reference").notNull(),
    canonicalItemId: uuid("canonical_item_id").notNull(),
    itemReference: text("item_reference").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.providerInstanceId, table.itemReference, table.artworkReference],
    }),
    unique("provider_artwork_mapping_identity_owner_unique").on(
      table.artworkId,
      table.canonicalItemId,
    ),
    unique("provider_artwork_mapping_active_fk_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.artworkReference,
      table.canonicalItemId,
      table.artworkId,
    ),
    foreignKey({
      columns: [table.providerInstanceId, table.itemReference, table.canonicalItemId],
      foreignColumns: [
        providerItemMapping.providerInstanceId,
        providerItemMapping.itemReference,
        providerItemMapping.canonicalItemId,
      ],
      name: "provider_artwork_mapping_item_owner_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    check(
      "provider_artwork_mapping_reference_check",
      sql`char_length(${table.artworkReference}) between 1 and 256`,
    ),
  ],
);

const canonicalArtwork = pgTable(
  "canonical_artwork",
  {
    artworkReference: text("artwork_reference").notNull(),
    canonicalItemId: uuid("canonical_item_id")
      .notNull()
      .references(() => canonicalItem.id, { onDelete: "cascade" }),
    displayOrder: integer("display_order").notNull(),
    height: bigint("height", { mode: "number" }),
    id: uuid("id").primaryKey(),
    itemReference: text("item_reference").notNull(),
    locale: text("locale"),
    providerInstanceId: text("provider_instance_id").notNull(),
    role: text("role").notNull(),
    textPresence: text("text_presence").notNull(),
    width: bigint("width", { mode: "number" }),
  },
  (table) => [
    foreignKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.artworkReference,
        table.canonicalItemId,
        table.id,
      ],
      foreignColumns: [
        providerArtworkMapping.providerInstanceId,
        providerArtworkMapping.itemReference,
        providerArtworkMapping.artworkReference,
        providerArtworkMapping.canonicalItemId,
        providerArtworkMapping.artworkId,
      ],
      name: "canonical_artwork_provider_mapping_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    check("canonical_artwork_order_check", sql`${table.displayOrder} >= 0`),
    check(
      "canonical_artwork_role_check",
      sql`${table.role} in ('poster', 'backdrop', 'logo', 'thumbnail', 'portrait')`,
    ),
    check(
      "canonical_artwork_dimensions_check",
      sql`(${table.width} is null or ${table.width} between 1 and 4294967295) and (${table.height} is null or ${table.height} between 1 and 4294967295)`,
    ),
    check(
      "canonical_artwork_locale_check",
      sql`${table.locale} is null or (${table.locale} ~ '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$' and char_length(${table.locale}) <= 256)`,
    ),
    check(
      "canonical_artwork_text_presence_check",
      sql`${table.textPresence} in ('unknown', 'textless', 'contains_text')`,
    ),
    uniqueIndex("canonical_artwork_provider_item_order_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.displayOrder,
    ),
  ],
);

const canonicalCredit = pgTable(
  "canonical_credit",
  {
    canonicalItemId: uuid("canonical_item_id")
      .notNull()
      .references(() => canonicalItem.id, { onDelete: "cascade" }),
    characterName: text("character_name"),
    displayOrder: integer("display_order").notNull(),
    name: text("name").notNull(),
    portraitArtworkId: uuid("portrait_artwork_id").references(() => canonicalArtwork.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.canonicalItemId, table.displayOrder] }),
    check("canonical_credit_order_check", sql`${table.displayOrder} >= 0`),
    check("canonical_credit_name_check", sql`char_length(${table.name}) between 1 and 256`),
    check(
      "canonical_credit_character_check",
      sql`${table.characterName} is null or char_length(${table.characterName}) between 1 and 256`,
    ),
    check("canonical_credit_role_check", sql`${table.role} in ('actor', 'director', 'writer')`),
  ],
);
export { canonicalArtwork, canonicalCredit, providerArtworkMapping };
