ALTER TABLE "canonical_artwork" DROP CONSTRAINT "canonical_artwork_provider_mapping_fk";--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" DROP CONSTRAINT "provider_artwork_mapping_active_fk_unique";--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" DROP CONSTRAINT "provider_artwork_mapping_provider_instance_id_item_reference_artwork_reference_pk";--> statement-breakpoint
ALTER TABLE "canonical_artwork" ADD COLUMN "target_item_reference" text;--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ADD COLUMN "target_item_reference" text;--> statement-breakpoint
UPDATE "canonical_artwork" SET "target_item_reference" = "item_reference";--> statement-breakpoint
UPDATE "provider_artwork_mapping" SET "target_item_reference" = "item_reference";--> statement-breakpoint
ALTER TABLE "canonical_artwork" ALTER COLUMN "target_item_reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ALTER COLUMN "target_item_reference" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ADD CONSTRAINT "provider_artwork_mapping_provider_instance_id_item_reference_target_item_reference_artwork_reference_pk" PRIMARY KEY("provider_instance_id","item_reference","target_item_reference","artwork_reference");--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ADD CONSTRAINT "provider_artwork_mapping_active_fk_unique" UNIQUE("provider_instance_id","item_reference","artwork_reference","target_item_reference","canonical_item_id","artwork_id");--> statement-breakpoint
ALTER TABLE "canonical_artwork" ADD CONSTRAINT "canonical_artwork_provider_mapping_fk" FOREIGN KEY ("provider_instance_id","item_reference","artwork_reference","target_item_reference","canonical_item_id","id") REFERENCES "public"."provider_artwork_mapping"("provider_instance_id","item_reference","artwork_reference","target_item_reference","canonical_item_id","artwork_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "provider_artwork_mapping" ADD CONSTRAINT "provider_artwork_mapping_target_reference_check" CHECK (char_length("provider_artwork_mapping"."target_item_reference") between 1 and 256);