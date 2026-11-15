import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { mediaPart, providerPartMapping } from "./catalog-source-schema.ts";

const providerTrackMapping = pgTable(
  "provider_track_mapping",
  {
    itemReference: text("item_reference").notNull(),
    partId: uuid("part_id").notNull(),
    partReference: text("part_reference").notNull(),
    providerInstanceId: text("provider_instance_id").notNull(),
    sourceReference: text("source_reference").notNull(),
    trackId: uuid("track_id").notNull(),
    trackReference: text("track_reference").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.sourceReference,
        table.partReference,
        table.trackReference,
      ],
    }),
    unique("provider_track_mapping_identity_owner_unique").on(table.trackId, table.partId),
    foreignKey({
      columns: [
        table.providerInstanceId,
        table.itemReference,
        table.sourceReference,
        table.partReference,
        table.partId,
      ],
      foreignColumns: [
        providerPartMapping.providerInstanceId,
        providerPartMapping.itemReference,
        providerPartMapping.sourceReference,
        providerPartMapping.partReference,
        providerPartMapping.partId,
      ],
      name: "provider_track_mapping_part_owner_fk",
    }).onDelete("cascade"),
    check(
      "provider_track_mapping_reference_check",
      sql`char_length(${table.trackReference}) between 1 and 256`,
    ),
  ],
);

const mediaTrack = pgTable(
  "media_track",
  {
    bitDepth: bigint("bit_depth", { mode: "number" }),
    channelCount: bigint("channel_count", { mode: "number" }),
    channelLayout: text("channel_layout"),
    codec: text("codec").notNull(),
    dynamicRange: text("dynamic_range"),
    frameRate: doublePrecision("frame_rate"),
    height: bigint("height", { mode: "number" }),
    id: uuid("id").primaryKey(),
    isCommentary: boolean("is_commentary").default(false).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    isForced: boolean("is_forced").default(false).notNull(),
    isHearingImpaired: boolean("is_hearing_impaired").default(false).notNull(),
    language: text("language"),
    partId: uuid("part_id")
      .notNull()
      .references(() => mediaPart.id, { onDelete: "cascade" }),
    representation: text("representation"),
    sampleRateHz: bigint("sample_rate_hz", { mode: "number" }),
    spatialFormat: text("spatial_format"),
    title: text("title"),
    trackOrder: integer("track_order").notNull(),
    type: text("type").notNull(),
    width: bigint("width", { mode: "number" }),
  },
  (table) => [
    foreignKey({
      columns: [table.id, table.partId],
      foreignColumns: [providerTrackMapping.trackId, providerTrackMapping.partId],
      name: "media_track_provider_mapping_fk",
    }).onDelete("cascade"),
    check("media_track_order_check", sql`${table.trackOrder} >= 0`),
    check("media_track_type_check", sql`${table.type} in ('video', 'audio', 'subtitle')`),
    check("media_track_codec_check", sql`char_length(${table.codec}) between 1 and 256`),
    check(
      "media_track_title_check",
      sql`${table.title} is null or char_length(${table.title}) between 1 and 256`,
    ),
    check(
      "media_track_language_check",
      sql`${table.language} is null or char_length(${table.language}) between 1 and 256`,
    ),
    check(
      "media_track_video_dimensions_check",
      sql`(${table.width} is null or ${table.width} between 1 and 4294967295) and (${table.height} is null or ${table.height} between 1 and 4294967295) and (${table.frameRate} is null or ${table.frameRate} > 0) and (${table.bitDepth} is null or ${table.bitDepth} between 1 and 4294967295)`,
    ),
    check(
      "media_track_dynamic_range_check",
      sql`${table.dynamicRange} is null or ${table.dynamicRange} in ('sdr', 'hdr10', 'hdr10_plus', 'hlg', 'dolby_vision')`,
    ),
    check(
      "media_track_channel_count_check",
      sql`${table.channelCount} is null or ${table.channelCount} between 0 and 4294967295`,
    ),
    check(
      "media_track_sample_rate_check",
      sql`${table.sampleRateHz} is null or ${table.sampleRateHz} between 1 and 4294967295`,
    ),
    check(
      "media_track_spatial_format_check",
      sql`${table.spatialFormat} is null or ${table.spatialFormat} in ('none', 'dolby_atmos', 'dts_x')`,
    ),
    check(
      "media_track_representation_check",
      sql`(${table.type} = 'subtitle' and ${table.representation} in ('text', 'image')) or (${table.type} <> 'subtitle' and ${table.representation} is null)`,
    ),
    uniqueIndex("media_track_part_order_unique").on(table.partId, table.trackOrder),
  ],
);
export { mediaTrack, providerTrackMapping };
