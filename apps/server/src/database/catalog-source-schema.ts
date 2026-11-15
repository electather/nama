import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { canonicalItem, providerItemMapping } from "./catalog-item-schema.ts";
import { providerInstance } from "./provider-schema.ts";

const providerSourceMapping = pgTable(
  "provider_source_mapping",
  {
    canonicalItemId: uuid("canonical_item_id").notNull(),
    itemReference: text("item_reference").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceReference: text("source_reference").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.providerInstanceId, table.itemReference, table.sourceReference],
    }),
    unique("provider_source_mapping_identity_owner_unique").on(
      table.sourceId,
      table.canonicalItemId,
    ),
    unique("provider_source_mapping_active_fk_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.sourceReference,
      table.canonicalItemId,
      table.sourceId,
    ),
    unique("provider_source_mapping_part_owner_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.sourceReference,
      table.sourceId,
    ),
    foreignKey({
      columns: [table.providerInstanceId, table.itemReference, table.canonicalItemId],
      foreignColumns: [
        providerItemMapping.providerInstanceId,
        providerItemMapping.itemReference,
        providerItemMapping.canonicalItemId,
      ],
      name: "provider_source_mapping_item_owner_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    check(
      "provider_source_mapping_reference_check",
      sql`char_length(${table.sourceReference}) between 1 and 256`,
    ),
  ],
);

const mediaSource = pgTable(
  "media_source",
  {
    availability: text("availability").notNull(),
    bitRateBps: bigint("bit_rate_bps", { mode: "bigint" }),
    canonicalItemId: uuid("canonical_item_id")
      .notNull()
      .references(() => canonicalItem.id, { onDelete: "cascade" }),
    id: uuid("id").primaryKey(),
    itemReference: text("item_reference").notNull(),
    label: text("label"),
    providerInstanceId: text("provider_instance_id")
      .notNull()
      .references(() => providerInstance.id, { onDelete: "cascade" }),
    runtimeNanoseconds: integer("runtime_nanoseconds").notNull(),
    runtimeSeconds: bigint("runtime_seconds", { mode: "bigint" }).notNull(),
    sourceOrder: integer("source_order").notNull(),
    sourceReference: text("source_reference").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.sourceReference,
        table.canonicalItemId,
        table.id,
      ],
      foreignColumns: [
        providerSourceMapping.providerInstanceId,
        providerSourceMapping.itemReference,
        providerSourceMapping.sourceReference,
        providerSourceMapping.canonicalItemId,
        providerSourceMapping.sourceId,
      ],
      name: "media_source_provider_mapping_fk",
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    check("media_source_order_check", sql`${table.sourceOrder} >= 0`),
    check(
      "media_source_label_check",
      sql`${table.label} is null or char_length(${table.label}) between 1 and 256`,
    ),
    check(
      "media_source_availability_check",
      sql`${table.availability} in ('available', 'provider_unavailable', 'unsupported')`,
    ),
    check("media_source_runtime_check", sql`${table.runtimeSeconds} >= 0`),
    check(
      "media_source_runtime_nanoseconds_check",
      sql`${table.runtimeNanoseconds} between 0 and 999999999`,
    ),
    check(
      "media_source_bit_rate_check",
      sql`${table.bitRateBps} is null or ${table.bitRateBps} > 0`,
    ),
    uniqueIndex("media_source_provider_item_order_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.sourceOrder,
    ),
    index("media_source_canonical_item_index").on(table.canonicalItemId),
  ],
);

const providerPartMapping = pgTable(
  "provider_part_mapping",
  {
    itemReference: text("item_reference").notNull(),
    partId: uuid("part_id").notNull(),
    partReference: text("part_reference").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    sourceReference: text("source_reference").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.sourceReference,
        table.partReference,
      ],
    }),
    unique("provider_part_mapping_identity_owner_unique").on(table.partId, table.sourceId),
    unique("provider_part_mapping_track_owner_unique").on(
      table.providerInstanceId,
      table.itemReference,
      table.sourceReference,
      table.partReference,
      table.partId,
    ),
    foreignKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.sourceReference,
        table.sourceId,
      ],
      foreignColumns: [
        providerSourceMapping.providerInstanceId,
        providerSourceMapping.itemReference,
        providerSourceMapping.sourceReference,
        providerSourceMapping.sourceId,
      ],
      name: "provider_part_mapping_source_owner_fk",
    }).onDelete("cascade"),
    check(
      "provider_part_mapping_reference_check",
      sql`char_length(${table.partReference}) between 1 and 256`,
    ),
  ],
);

const mediaPart = pgTable(
  "media_part",
  {
    bitRateBps: bigint("bit_rate_bps", { mode: "bigint" }),
    container: text("container").notNull(),
    id: uuid("id").primaryKey(),
    partOrder: integer("part_order").notNull(),
    runtimeNanoseconds: integer("runtime_nanoseconds").notNull(),
    runtimeSeconds: bigint("runtime_seconds", { mode: "bigint" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => mediaSource.id, { onDelete: "cascade" }),
  },
  (table) => [
    foreignKey({
      columns: [table.id, table.sourceId],
      foreignColumns: [providerPartMapping.partId, providerPartMapping.sourceId],
      name: "media_part_provider_mapping_fk",
    }).onDelete("cascade"),
    check("media_part_order_check", sql`${table.partOrder} >= 0`),
    check("media_part_container_check", sql`char_length(${table.container}) between 1 and 256`),
    check("media_part_runtime_check", sql`${table.runtimeSeconds} >= 0`),
    check(
      "media_part_runtime_nanoseconds_check",
      sql`${table.runtimeNanoseconds} between 0 and 999999999`,
    ),
    check("media_part_size_check", sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`),
    check("media_part_bit_rate_check", sql`${table.bitRateBps} is null or ${table.bitRateBps} > 0`),
    uniqueIndex("media_part_source_order_unique").on(table.sourceId, table.partOrder),
  ],
);
export { mediaPart, mediaSource, providerPartMapping, providerSourceMapping };
