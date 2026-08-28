CREATE TABLE "provider_watch_state_replica" (
	"canonical_item_id" uuid NOT NULL,
	"canonical_item_kind" text NOT NULL,
	"duration_nanoseconds" integer,
	"duration_seconds" bigint,
	"observed_at" timestamp with time zone NOT NULL,
	"position_nanoseconds" integer,
	"position_seconds" bigint,
	"principal_id" text NOT NULL,
	"provider_activity_occurred_at" timestamp with time zone,
	"provider_activity_reliability" text,
	"provider_activity_semantics" text,
	"provider_instance_id" text NOT NULL,
	"provider_item_reference" text NOT NULL,
	"provider_revision" text,
	"version" bigint NOT NULL,
	"watched" boolean NOT NULL,
	CONSTRAINT "provider_watch_state_replica_principal_id_provider_instance_id_provider_item_reference_pk" PRIMARY KEY("principal_id","provider_instance_id","provider_item_reference"),
	CONSTRAINT "provider_watch_state_replica_playable_kind_check" CHECK ("provider_watch_state_replica"."canonical_item_kind" in ('movie', 'episode')),
	CONSTRAINT "provider_watch_state_replica_position_pair_check" CHECK (("provider_watch_state_replica"."position_seconds" is null) = ("provider_watch_state_replica"."position_nanoseconds" is null)),
	CONSTRAINT "provider_watch_state_replica_position_check" CHECK ("provider_watch_state_replica"."position_seconds" is null or ("provider_watch_state_replica"."position_seconds" >= 0 and "provider_watch_state_replica"."position_nanoseconds" between 0 and 999999999)),
	CONSTRAINT "provider_watch_state_replica_duration_pair_check" CHECK (("provider_watch_state_replica"."duration_seconds" is null) = ("provider_watch_state_replica"."duration_nanoseconds" is null)),
	CONSTRAINT "provider_watch_state_replica_duration_check" CHECK ("provider_watch_state_replica"."duration_seconds" is null or ("provider_watch_state_replica"."duration_seconds" >= 0 and "provider_watch_state_replica"."duration_nanoseconds" between 0 and 999999999)),
	CONSTRAINT "provider_watch_state_replica_activity_presence_check" CHECK (("provider_watch_state_replica"."provider_activity_occurred_at" is null) = ("provider_watch_state_replica"."provider_activity_reliability" is null)
          and ("provider_watch_state_replica"."provider_activity_occurred_at" is null) = ("provider_watch_state_replica"."provider_activity_semantics" is null)),
	CONSTRAINT "provider_watch_state_replica_activity_reliability_check" CHECK ("provider_watch_state_replica"."provider_activity_reliability" is null or "provider_watch_state_replica"."provider_activity_reliability" in ('reliable', 'heuristic')),
	CONSTRAINT "provider_watch_state_replica_activity_semantics_check" CHECK ("provider_watch_state_replica"."provider_activity_semantics" is null or "provider_watch_state_replica"."provider_activity_semantics" in ('unknown', 'playback_started', 'playback_completed', 'state_changed')),
	CONSTRAINT "provider_watch_state_replica_revision_check" CHECK ("provider_watch_state_replica"."provider_revision" is null or char_length("provider_watch_state_replica"."provider_revision") between 1 and 256),
	CONSTRAINT "provider_watch_state_replica_version_check" CHECK ("provider_watch_state_replica"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_watch_state_replica" ADD CONSTRAINT "provider_watch_state_replica_principal_id_user_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_watch_state_replica" ADD CONSTRAINT "provider_watch_state_replica_item_mapping_fk" FOREIGN KEY ("provider_instance_id","provider_item_reference","canonical_item_id") REFERENCES "public"."provider_item_mapping"("provider_instance_id","item_reference","canonical_item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_watch_state_replica" ADD CONSTRAINT "provider_watch_state_replica_playable_item_fk" FOREIGN KEY ("canonical_item_id","canonical_item_kind") REFERENCES "public"."canonical_item"("id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_watch_state_replica_mapping_index" ON "provider_watch_state_replica" USING btree ("provider_instance_id","provider_item_reference","canonical_item_id");