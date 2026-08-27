CREATE TABLE "canonical_watch_state" (
	"activity_occurred_at" timestamp with time zone NOT NULL,
	"activity_origin" text NOT NULL,
	"activity_reliability" text NOT NULL,
	"activity_semantics" text NOT NULL,
	"canonical_item_id" uuid NOT NULL,
	"canonical_item_kind" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"duration_nanoseconds" integer,
	"duration_seconds" bigint,
	"last_source_id" uuid,
	"position_nanoseconds" integer,
	"position_seconds" bigint,
	"principal_id" text NOT NULL,
	"version" bigint NOT NULL,
	"watched" boolean NOT NULL,
	CONSTRAINT "canonical_watch_state_principal_id_canonical_item_id_pk" PRIMARY KEY("principal_id","canonical_item_id"),
	CONSTRAINT "canonical_watch_state_playable_kind_check" CHECK ("canonical_watch_state"."canonical_item_kind" in ('movie', 'episode')),
	CONSTRAINT "canonical_watch_state_position_pair_check" CHECK (("canonical_watch_state"."position_seconds" is null) = ("canonical_watch_state"."position_nanoseconds" is null)),
	CONSTRAINT "canonical_watch_state_position_check" CHECK ("canonical_watch_state"."position_seconds" is null or ("canonical_watch_state"."position_seconds" >= 0 and "canonical_watch_state"."position_nanoseconds" between 0 and 999999999)),
	CONSTRAINT "canonical_watch_state_duration_pair_check" CHECK (("canonical_watch_state"."duration_seconds" is null) = ("canonical_watch_state"."duration_nanoseconds" is null)),
	CONSTRAINT "canonical_watch_state_duration_check" CHECK ("canonical_watch_state"."duration_seconds" is null or ("canonical_watch_state"."duration_seconds" >= 0 and "canonical_watch_state"."duration_nanoseconds" between 0 and 999999999)),
	CONSTRAINT "canonical_watch_state_activity_origin_check" CHECK ("canonical_watch_state"."activity_origin" in ('nama', 'provider')),
	CONSTRAINT "canonical_watch_state_activity_reliability_check" CHECK ("canonical_watch_state"."activity_reliability" in ('reliable', 'heuristic')),
	CONSTRAINT "canonical_watch_state_activity_semantics_check" CHECK ("canonical_watch_state"."activity_semantics" in ('unknown', 'playback_started', 'playback_completed', 'state_changed')),
	CONSTRAINT "canonical_watch_state_version_check" CHECK ("canonical_watch_state"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "canonical_watch_state" ADD CONSTRAINT "canonical_watch_state_principal_id_user_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_watch_state" ADD CONSTRAINT "canonical_watch_state_playable_item_fk" FOREIGN KEY ("canonical_item_id","canonical_item_kind") REFERENCES "public"."canonical_item"("id","kind") ON DELETE cascade ON UPDATE no action;