CREATE TABLE "canonical_artwork" (
	"artwork_reference" text NOT NULL,
	"canonical_item_id" uuid NOT NULL,
	"display_order" integer NOT NULL,
	"height" bigint,
	"id" uuid PRIMARY KEY NOT NULL,
	"item_reference" text NOT NULL,
	"locale" text,
	"provider_instance_id" text NOT NULL,
	"role" text NOT NULL,
	"text_presence" text NOT NULL,
	"width" bigint,
	CONSTRAINT "canonical_artwork_order_check" CHECK ("canonical_artwork"."display_order" >= 0),
	CONSTRAINT "canonical_artwork_role_check" CHECK ("canonical_artwork"."role" in ('poster', 'backdrop', 'logo', 'thumbnail', 'portrait')),
	CONSTRAINT "canonical_artwork_dimensions_check" CHECK (("canonical_artwork"."width" is null or "canonical_artwork"."width" between 1 and 4294967295) and ("canonical_artwork"."height" is null or "canonical_artwork"."height" between 1 and 4294967295)),
	CONSTRAINT "canonical_artwork_locale_check" CHECK ("canonical_artwork"."locale" is null or ("canonical_artwork"."locale" ~ '^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$' and char_length("canonical_artwork"."locale") <= 256)),
	CONSTRAINT "canonical_artwork_text_presence_check" CHECK ("canonical_artwork"."text_presence" in ('unknown', 'textless', 'contains_text'))
);
--> statement-breakpoint
CREATE TABLE "canonical_credit" (
	"canonical_item_id" uuid NOT NULL,
	"character_name" text,
	"display_order" integer NOT NULL,
	"name" text NOT NULL,
	"portrait_artwork_id" uuid,
	"role" text NOT NULL,
	CONSTRAINT "canonical_credit_canonical_item_id_display_order_pk" PRIMARY KEY("canonical_item_id","display_order"),
	CONSTRAINT "canonical_credit_order_check" CHECK ("canonical_credit"."display_order" >= 0),
	CONSTRAINT "canonical_credit_name_check" CHECK (char_length("canonical_credit"."name") between 1 and 256),
	CONSTRAINT "canonical_credit_character_check" CHECK ("canonical_credit"."character_name" is null or char_length("canonical_credit"."character_name") between 1 and 256),
	CONSTRAINT "canonical_credit_role_check" CHECK ("canonical_credit"."role" in ('actor', 'director', 'writer'))
);
--> statement-breakpoint
CREATE TABLE "canonical_hierarchy" (
	"child_item_id" uuid NOT NULL,
	"child_kind" text NOT NULL,
	"parent_item_id" uuid NOT NULL,
	"parent_kind" text NOT NULL,
	"relationship" text NOT NULL,
	CONSTRAINT "canonical_hierarchy_child_item_id_relationship_pk" PRIMARY KEY("child_item_id","relationship"),
	CONSTRAINT "canonical_hierarchy_kind_check" CHECK (("canonical_hierarchy"."relationship" = 'show' and "canonical_hierarchy"."child_kind" in ('season', 'episode') and "canonical_hierarchy"."parent_kind" = 'show')
          or ("canonical_hierarchy"."relationship" = 'season' and "canonical_hierarchy"."child_kind" = 'episode' and "canonical_hierarchy"."parent_kind" = 'season')),
	CONSTRAINT "canonical_hierarchy_distinct_items_check" CHECK ("canonical_hierarchy"."child_item_id" <> "canonical_hierarchy"."parent_item_id")
);
--> statement-breakpoint
CREATE TABLE "canonical_item" (
	"content_rating" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"episode_count" bigint,
	"episode_number" bigint,
	"first_release_date" date,
	"genres" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"last_release_date" date,
	"original_title" text,
	"release_date" date,
	"release_year" bigint,
	"runtime_nanoseconds" integer NOT NULL,
	"runtime_seconds" bigint NOT NULL,
	"season_count" bigint,
	"season_number" bigint,
	"studios" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"synopsis" text,
	"tagline" text,
	"title" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "canonical_item_id_kind_unique" UNIQUE("id","kind"),
	CONSTRAINT "canonical_item_kind_check" CHECK ("canonical_item"."kind" in ('movie', 'show', 'season', 'episode')),
	CONSTRAINT "canonical_item_title_check" CHECK (char_length("canonical_item"."title") between 1 and 256),
	CONSTRAINT "canonical_item_original_title_check" CHECK ("canonical_item"."original_title" is null or char_length("canonical_item"."original_title") between 1 and 256),
	CONSTRAINT "canonical_item_synopsis_check" CHECK ("canonical_item"."synopsis" is null or char_length("canonical_item"."synopsis") <= 16384),
	CONSTRAINT "canonical_item_tagline_check" CHECK ("canonical_item"."tagline" is null or char_length("canonical_item"."tagline") between 1 and 256),
	CONSTRAINT "canonical_item_content_rating_check" CHECK ("canonical_item"."content_rating" is null or char_length("canonical_item"."content_rating") between 1 and 256),
	CONSTRAINT "canonical_item_release_year_check" CHECK ("canonical_item"."release_year" is null or "canonical_item"."release_year" between 0 and 4294967295),
	CONSTRAINT "canonical_item_runtime_check" CHECK ("canonical_item"."runtime_seconds" >= 0),
	CONSTRAINT "canonical_item_runtime_nanoseconds_check" CHECK ("canonical_item"."runtime_nanoseconds" between 0 and 999999999),
	CONSTRAINT "canonical_item_genres_check" CHECK (cardinality("canonical_item"."genres") <= 50),
	CONSTRAINT "canonical_item_studios_check" CHECK (cardinality("canonical_item"."studios") <= 50),
	CONSTRAINT "canonical_item_counts_check" CHECK (("canonical_item"."season_count" is null or "canonical_item"."season_count" between 0 and 4294967295) and ("canonical_item"."episode_count" is null or "canonical_item"."episode_count" between 0 and 4294967295)),
	CONSTRAINT "canonical_item_kind_details_check" CHECK (("canonical_item"."kind" = 'movie' and "canonical_item"."first_release_date" is null and "canonical_item"."last_release_date" is null and "canonical_item"."season_count" is null and "canonical_item"."episode_count" is null and "canonical_item"."season_number" is null and "canonical_item"."episode_number" is null)
          or ("canonical_item"."kind" = 'show' and "canonical_item"."release_date" is null and "canonical_item"."season_number" is null and "canonical_item"."episode_number" is null)
          or ("canonical_item"."kind" = 'season' and "canonical_item"."release_date" is null and "canonical_item"."first_release_date" is null and "canonical_item"."last_release_date" is null and "canonical_item"."season_count" is null and "canonical_item"."season_number" between 1 and 4294967295 and "canonical_item"."episode_number" is null)
          or ("canonical_item"."kind" = 'episode' and "canonical_item"."first_release_date" is null and "canonical_item"."last_release_date" is null and "canonical_item"."season_count" is null and "canonical_item"."episode_count" is null and "canonical_item"."season_number" between 1 and 4294967295 and "canonical_item"."episode_number" between 1 and 4294967295)),
	CONSTRAINT "canonical_item_timestamps_check" CHECK ("canonical_item"."updated_at" >= "canonical_item"."created_at")
);
--> statement-breakpoint
CREATE TABLE "library_entry" (
	"canonical_item_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_part" (
	"bit_rate_bps" bigint,
	"container" text NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"part_order" integer NOT NULL,
	"runtime_nanoseconds" integer NOT NULL,
	"runtime_seconds" bigint NOT NULL,
	"size_bytes" bigint,
	"source_id" uuid NOT NULL,
	CONSTRAINT "media_part_order_check" CHECK ("media_part"."part_order" >= 0),
	CONSTRAINT "media_part_container_check" CHECK (char_length("media_part"."container") between 1 and 256),
	CONSTRAINT "media_part_runtime_check" CHECK ("media_part"."runtime_seconds" >= 0),
	CONSTRAINT "media_part_runtime_nanoseconds_check" CHECK ("media_part"."runtime_nanoseconds" between 0 and 999999999),
	CONSTRAINT "media_part_size_check" CHECK ("media_part"."size_bytes" is null or "media_part"."size_bytes" >= 0),
	CONSTRAINT "media_part_bit_rate_check" CHECK ("media_part"."bit_rate_bps" is null or "media_part"."bit_rate_bps" > 0)
);
--> statement-breakpoint
CREATE TABLE "media_source" (
	"availability" text NOT NULL,
	"bit_rate_bps" bigint,
	"canonical_item_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"item_reference" text NOT NULL,
	"label" text,
	"provider_instance_id" text NOT NULL,
	"runtime_nanoseconds" integer NOT NULL,
	"runtime_seconds" bigint NOT NULL,
	"source_order" integer NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "media_source_order_check" CHECK ("media_source"."source_order" >= 0),
	CONSTRAINT "media_source_label_check" CHECK ("media_source"."label" is null or char_length("media_source"."label") between 1 and 256),
	CONSTRAINT "media_source_availability_check" CHECK ("media_source"."availability" in ('available', 'provider_unavailable', 'unsupported')),
	CONSTRAINT "media_source_runtime_check" CHECK ("media_source"."runtime_seconds" >= 0),
	CONSTRAINT "media_source_runtime_nanoseconds_check" CHECK ("media_source"."runtime_nanoseconds" between 0 and 999999999),
	CONSTRAINT "media_source_bit_rate_check" CHECK ("media_source"."bit_rate_bps" is null or "media_source"."bit_rate_bps" > 0)
);
--> statement-breakpoint
CREATE TABLE "media_track" (
	"bit_depth" bigint,
	"channel_count" bigint,
	"channel_layout" text,
	"codec" text NOT NULL,
	"dynamic_range" text,
	"frame_rate" double precision,
	"height" bigint,
	"id" uuid PRIMARY KEY NOT NULL,
	"is_commentary" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_forced" boolean DEFAULT false NOT NULL,
	"is_hearing_impaired" boolean DEFAULT false NOT NULL,
	"language" text,
	"part_id" uuid NOT NULL,
	"representation" text,
	"sample_rate_hz" bigint,
	"spatial_format" text,
	"title" text,
	"track_order" integer NOT NULL,
	"type" text NOT NULL,
	"width" bigint,
	CONSTRAINT "media_track_order_check" CHECK ("media_track"."track_order" >= 0),
	CONSTRAINT "media_track_type_check" CHECK ("media_track"."type" in ('video', 'audio', 'subtitle')),
	CONSTRAINT "media_track_codec_check" CHECK (char_length("media_track"."codec") between 1 and 256),
	CONSTRAINT "media_track_title_check" CHECK ("media_track"."title" is null or char_length("media_track"."title") between 1 and 256),
	CONSTRAINT "media_track_language_check" CHECK ("media_track"."language" is null or char_length("media_track"."language") between 1 and 256),
	CONSTRAINT "media_track_video_dimensions_check" CHECK (("media_track"."width" is null or "media_track"."width" between 1 and 4294967295) and ("media_track"."height" is null or "media_track"."height" between 1 and 4294967295) and ("media_track"."frame_rate" is null or "media_track"."frame_rate" > 0) and ("media_track"."bit_depth" is null or "media_track"."bit_depth" between 1 and 4294967295)),
	CONSTRAINT "media_track_dynamic_range_check" CHECK ("media_track"."dynamic_range" is null or "media_track"."dynamic_range" in ('sdr', 'hdr10', 'hdr10_plus', 'hlg', 'dolby_vision')),
	CONSTRAINT "media_track_channel_count_check" CHECK ("media_track"."channel_count" is null or "media_track"."channel_count" between 0 and 4294967295),
	CONSTRAINT "media_track_sample_rate_check" CHECK ("media_track"."sample_rate_hz" is null or "media_track"."sample_rate_hz" between 1 and 4294967295),
	CONSTRAINT "media_track_spatial_format_check" CHECK ("media_track"."spatial_format" is null or "media_track"."spatial_format" in ('none', 'dolby_atmos', 'dts_x')),
	CONSTRAINT "media_track_representation_check" CHECK (("media_track"."type" = 'subtitle' and "media_track"."representation" in ('text', 'image')) or ("media_track"."type" <> 'subtitle' and "media_track"."representation" is null))
);
--> statement-breakpoint
CREATE TABLE "provider_artwork_mapping" (
	"artwork_id" uuid NOT NULL,
	"artwork_reference" text NOT NULL,
	"canonical_item_id" uuid NOT NULL,
	"item_reference" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	CONSTRAINT "provider_artwork_mapping_provider_instance_id_item_reference_artwork_reference_pk" PRIMARY KEY("provider_instance_id","item_reference","artwork_reference"),
	CONSTRAINT "provider_artwork_mapping_identity_owner_unique" UNIQUE("artwork_id","canonical_item_id"),
	CONSTRAINT "provider_artwork_mapping_active_fk_unique" UNIQUE("provider_instance_id","item_reference","artwork_reference","canonical_item_id","artwork_id"),
	CONSTRAINT "provider_artwork_mapping_reference_check" CHECK (char_length("provider_artwork_mapping"."artwork_reference") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "provider_catalog_scan_state" (
	"captured_provider_revision" text NOT NULL,
	"completed_at" timestamp with time zone,
	"core_run_id" text NOT NULL,
	"last_accepted_continuation" text,
	"next_retry_at" timestamp with time zone,
	"provider_instance_id" text PRIMARY KEY NOT NULL,
	"safe_failure_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_catalog_scan_state_revision_check" CHECK (char_length("provider_catalog_scan_state"."captured_provider_revision") between 1 and 256),
	CONSTRAINT "provider_catalog_scan_state_run_check" CHECK (char_length("provider_catalog_scan_state"."core_run_id") between 1 and 256),
	CONSTRAINT "provider_catalog_scan_state_status_check" CHECK ("provider_catalog_scan_state"."status" in ('running', 'succeeded', 'failed', 'paused')),
	CONSTRAINT "provider_catalog_scan_state_continuation_check" CHECK ("provider_catalog_scan_state"."last_accepted_continuation" is null or char_length("provider_catalog_scan_state"."last_accepted_continuation") between 1 and 4096),
	CONSTRAINT "provider_catalog_scan_state_failure_check" CHECK ("provider_catalog_scan_state"."safe_failure_reason" is null or char_length("provider_catalog_scan_state"."safe_failure_reason") between 1 and 256),
	CONSTRAINT "provider_catalog_scan_state_completion_check" CHECK (("provider_catalog_scan_state"."status" = 'running' and "provider_catalog_scan_state"."completed_at" is null and "provider_catalog_scan_state"."safe_failure_reason" is null)
          or ("provider_catalog_scan_state"."status" = 'succeeded' and "provider_catalog_scan_state"."completed_at" is not null and "provider_catalog_scan_state"."safe_failure_reason" is null and "provider_catalog_scan_state"."next_retry_at" is null)
          or ("provider_catalog_scan_state"."status" = 'failed' and "provider_catalog_scan_state"."completed_at" is not null and "provider_catalog_scan_state"."safe_failure_reason" is not null)
          or ("provider_catalog_scan_state"."status" = 'paused' and "provider_catalog_scan_state"."completed_at" is not null)),
	CONSTRAINT "provider_catalog_scan_state_timestamps_check" CHECK ("provider_catalog_scan_state"."updated_at" >= "provider_catalog_scan_state"."started_at" and ("provider_catalog_scan_state"."completed_at" is null or "provider_catalog_scan_state"."completed_at" >= "provider_catalog_scan_state"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "provider_external_identifier" (
	"item_reference" text NOT NULL,
	"namespace" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "provider_external_identifier_provider_instance_id_item_reference_namespace_value_pk" PRIMARY KEY("provider_instance_id","item_reference","namespace","value"),
	CONSTRAINT "provider_external_identifier_namespace_check" CHECK (char_length("provider_external_identifier"."namespace") between 1 and 256 and "provider_external_identifier"."namespace" = lower(btrim("provider_external_identifier"."namespace"))),
	CONSTRAINT "provider_external_identifier_value_check" CHECK (char_length("provider_external_identifier"."value") between 1 and 256 and "provider_external_identifier"."value" = btrim("provider_external_identifier"."value"))
);
--> statement-breakpoint
CREATE TABLE "provider_item_mapping" (
	"canonical_item_id" uuid NOT NULL,
	"item_reference" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_scan_run_id" text,
	"provider_instance_id" text NOT NULL,
	CONSTRAINT "provider_item_mapping_provider_instance_id_item_reference_pk" PRIMARY KEY("provider_instance_id","item_reference"),
	CONSTRAINT "provider_item_mapping_owner_unique" UNIQUE("provider_instance_id","item_reference","canonical_item_id"),
	CONSTRAINT "provider_item_mapping_reference_check" CHECK (char_length("provider_item_mapping"."item_reference") between 1 and 256),
	CONSTRAINT "provider_item_mapping_scan_run_check" CHECK ("provider_item_mapping"."last_seen_scan_run_id" is null or char_length("provider_item_mapping"."last_seen_scan_run_id") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "provider_item_parent_reference" (
	"child_item_reference" text NOT NULL,
	"expected_parent_kind" text NOT NULL,
	"parent_item_reference" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"relationship" text NOT NULL,
	CONSTRAINT "provider_item_parent_reference_provider_instance_id_child_item_reference_relationship_pk" PRIMARY KEY("provider_instance_id","child_item_reference","relationship"),
	CONSTRAINT "provider_item_parent_reference_parent_check" CHECK (char_length("provider_item_parent_reference"."parent_item_reference") between 1 and 256),
	CONSTRAINT "provider_item_parent_reference_kind_check" CHECK (("provider_item_parent_reference"."relationship" = 'show' and "provider_item_parent_reference"."expected_parent_kind" = 'show') or ("provider_item_parent_reference"."relationship" = 'season' and "provider_item_parent_reference"."expected_parent_kind" = 'season'))
);
--> statement-breakpoint
CREATE TABLE "provider_part_mapping" (
	"item_reference" text NOT NULL,
	"part_id" uuid NOT NULL,
	"part_reference" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "provider_part_mapping_provider_instance_id_item_reference_source_reference_part_reference_pk" PRIMARY KEY("provider_instance_id","item_reference","source_reference","part_reference"),
	CONSTRAINT "provider_part_mapping_identity_owner_unique" UNIQUE("part_id","source_id"),
	CONSTRAINT "provider_part_mapping_track_owner_unique" UNIQUE("provider_instance_id","item_reference","source_reference","part_reference","part_id"),
	CONSTRAINT "provider_part_mapping_reference_check" CHECK (char_length("provider_part_mapping"."part_reference") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "provider_source_mapping" (
	"canonical_item_id" uuid NOT NULL,
	"item_reference" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_reference" text NOT NULL,
	CONSTRAINT "provider_source_mapping_provider_instance_id_item_reference_source_reference_pk" PRIMARY KEY("provider_instance_id","item_reference","source_reference"),
	CONSTRAINT "provider_source_mapping_identity_owner_unique" UNIQUE("source_id","canonical_item_id"),
	CONSTRAINT "provider_source_mapping_active_fk_unique" UNIQUE("provider_instance_id","item_reference","source_reference","canonical_item_id","source_id"),
	CONSTRAINT "provider_source_mapping_part_owner_unique" UNIQUE("provider_instance_id","item_reference","source_reference","source_id"),
	CONSTRAINT "provider_source_mapping_reference_check" CHECK (char_length("provider_source_mapping"."source_reference") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "provider_track_mapping" (
	"item_reference" text NOT NULL,
	"part_id" uuid NOT NULL,
	"part_reference" text NOT NULL,
	"provider_instance_id" text NOT NULL,
	"source_reference" text NOT NULL,
	"track_id" uuid NOT NULL,
	"track_reference" text NOT NULL,
	CONSTRAINT "provider_track_mapping_provider_instance_id_item_reference_source_reference_part_reference_track_reference_pk" PRIMARY KEY("provider_instance_id","item_reference","source_reference","part_reference","track_reference"),
	CONSTRAINT "provider_track_mapping_identity_owner_unique" UNIQUE("track_id","part_id"),
	CONSTRAINT "provider_track_mapping_reference_check" CHECK (char_length("provider_track_mapping"."track_reference") between 1 and 256)
);
--> statement-breakpoint
ALTER TABLE "canonical_artwork" ADD CONSTRAINT "canonical_artwork_canonical_item_id_canonical_item_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."canonical_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_artwork" ADD CONSTRAINT "canonical_artwork_provider_mapping_fk" FOREIGN KEY ("provider_instance_id","item_reference","artwork_reference","canonical_item_id","id") REFERENCES "public"."provider_artwork_mapping"("provider_instance_id","item_reference","artwork_reference","canonical_item_id","artwork_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "canonical_credit" ADD CONSTRAINT "canonical_credit_canonical_item_id_canonical_item_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."canonical_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_credit" ADD CONSTRAINT "canonical_credit_portrait_artwork_id_canonical_artwork_id_fk" FOREIGN KEY ("portrait_artwork_id") REFERENCES "public"."canonical_artwork"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_hierarchy" ADD CONSTRAINT "canonical_hierarchy_child_item_kind_fk" FOREIGN KEY ("child_item_id","child_kind") REFERENCES "public"."canonical_item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_hierarchy" ADD CONSTRAINT "canonical_hierarchy_parent_item_kind_fk" FOREIGN KEY ("parent_item_id","parent_kind") REFERENCES "public"."canonical_item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_entry" ADD CONSTRAINT "library_entry_canonical_item_id_canonical_item_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."canonical_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_part" ADD CONSTRAINT "media_part_source_id_media_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."media_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_part" ADD CONSTRAINT "media_part_provider_mapping_fk" FOREIGN KEY ("id","source_id") REFERENCES "public"."provider_part_mapping"("part_id","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_source" ADD CONSTRAINT "media_source_canonical_item_id_canonical_item_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."canonical_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_source" ADD CONSTRAINT "media_source_provider_instance_id_provider_instance_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_source" ADD CONSTRAINT "media_source_provider_mapping_fk" FOREIGN KEY ("provider_instance_id","item_reference","source_reference","canonical_item_id","id") REFERENCES "public"."provider_source_mapping"("provider_instance_id","item_reference","source_reference","canonical_item_id","source_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "media_track" ADD CONSTRAINT "media_track_part_id_media_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."media_part"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_track" ADD CONSTRAINT "media_track_provider_mapping_fk" FOREIGN KEY ("id","part_id") REFERENCES "public"."provider_track_mapping"("track_id","part_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ADD CONSTRAINT "provider_artwork_mapping_item_owner_fk" FOREIGN KEY ("provider_instance_id","item_reference","canonical_item_id") REFERENCES "public"."provider_item_mapping"("provider_instance_id","item_reference","canonical_item_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "provider_catalog_scan_state" ADD CONSTRAINT "provider_catalog_scan_state_provider_instance_id_provider_instance_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_external_identifier" ADD CONSTRAINT "provider_external_identifier_item_mapping_fk" FOREIGN KEY ("provider_instance_id","item_reference") REFERENCES "public"."provider_item_mapping"("provider_instance_id","item_reference") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_item_mapping" ADD CONSTRAINT "provider_item_mapping_canonical_item_id_canonical_item_id_fk" FOREIGN KEY ("canonical_item_id") REFERENCES "public"."canonical_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_item_mapping" ADD CONSTRAINT "provider_item_mapping_provider_instance_id_provider_instance_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_item_parent_reference" ADD CONSTRAINT "provider_item_parent_reference_child_mapping_fk" FOREIGN KEY ("provider_instance_id","child_item_reference") REFERENCES "public"."provider_item_mapping"("provider_instance_id","item_reference") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_part_mapping" ADD CONSTRAINT "provider_part_mapping_source_owner_fk" FOREIGN KEY ("provider_instance_id","item_reference","source_reference","source_id") REFERENCES "public"."provider_source_mapping"("provider_instance_id","item_reference","source_reference","source_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_source_mapping" ADD CONSTRAINT "provider_source_mapping_item_owner_fk" FOREIGN KEY ("provider_instance_id","item_reference","canonical_item_id") REFERENCES "public"."provider_item_mapping"("provider_instance_id","item_reference","canonical_item_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "provider_track_mapping" ADD CONSTRAINT "provider_track_mapping_part_owner_fk" FOREIGN KEY ("provider_instance_id","item_reference","source_reference","part_reference","part_id") REFERENCES "public"."provider_part_mapping"("provider_instance_id","item_reference","source_reference","part_reference","part_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_artwork_provider_item_order_unique" ON "canonical_artwork" USING btree ("provider_instance_id","item_reference","display_order");--> statement-breakpoint
CREATE INDEX "canonical_hierarchy_parent_index" ON "canonical_hierarchy" USING btree ("parent_item_id","relationship");--> statement-breakpoint
CREATE INDEX "library_entry_created_at_index" ON "library_entry" USING btree ("created_at","canonical_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_part_source_order_unique" ON "media_part" USING btree ("source_id","part_order");--> statement-breakpoint
CREATE UNIQUE INDEX "media_source_provider_item_order_unique" ON "media_source" USING btree ("provider_instance_id","item_reference","source_order");--> statement-breakpoint
CREATE INDEX "media_source_canonical_item_index" ON "media_source" USING btree ("canonical_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_track_part_order_unique" ON "media_track" USING btree ("part_id","track_order");--> statement-breakpoint
CREATE INDEX "provider_catalog_scan_state_retry_index" ON "provider_catalog_scan_state" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX "provider_external_identifier_evidence_index" ON "provider_external_identifier" USING btree ("namespace","value");--> statement-breakpoint
CREATE INDEX "provider_item_mapping_canonical_item_index" ON "provider_item_mapping" USING btree ("canonical_item_id");