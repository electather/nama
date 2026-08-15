CREATE TABLE "nama_fixture_upgrade" (
  "id" integer PRIMARY KEY,
  "value" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "nama_fixture_upgrade" ("id", "value") VALUES (1, 'prior');
