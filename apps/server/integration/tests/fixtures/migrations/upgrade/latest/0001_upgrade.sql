ALTER TABLE "nama_fixture_upgrade" ADD COLUMN "upgraded" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "nama_fixture_upgrade" SET "upgraded" = true;
