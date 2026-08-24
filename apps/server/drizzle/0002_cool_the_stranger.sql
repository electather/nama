CREATE TABLE "device" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "device_id_check" CHECK (char_length("device"."id") between 1 and 256),
	CONSTRAINT "device_display_name_check" CHECK (char_length("device"."display_name") between 1 and 256),
	CONSTRAINT "device_last_seen_at_check" CHECK ("device"."last_seen_at" is null or "device"."last_seen_at" >= "device"."created_at"),
	CONSTRAINT "device_revocation_state_check" CHECK ("device"."revoked" = ("device"."revoked_at" is not null)),
	CONSTRAINT "device_revoked_at_check" CHECK ("device"."revoked_at" is null or "device"."revoked_at" >= "device"."created_at")
);
--> statement-breakpoint
CREATE TABLE "device_credential" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text PRIMARY KEY NOT NULL,
	"verifier" "bytea" NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "device_credential_version_check" CHECK ("device_credential"."version" > 0),
	CONSTRAINT "device_credential_verifier_check" CHECK (octet_length("device_credential"."verifier") = 32)
);
--> statement-breakpoint
CREATE TABLE "pairing_approval_result" (
	"administrator_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"method" text NOT NULL,
	"operation_id" text NOT NULL,
	"pairing_id" text NOT NULL,
	"request_fingerprint" "bytea" NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "pairing_approval_result_administrator_user_id_method_operation_id_pk" PRIMARY KEY("administrator_user_id","method","operation_id"),
	CONSTRAINT "pairing_approval_result_method_check" CHECK ("pairing_approval_result"."method" = 'nama.api.v1.DeviceService.ApprovePairing'),
	CONSTRAINT "pairing_approval_result_operation_id_check" CHECK (char_length("pairing_approval_result"."operation_id") between 1 and 256),
	CONSTRAINT "pairing_approval_result_pairing_id_check" CHECK (char_length("pairing_approval_result"."pairing_id") between 1 and 256),
	CONSTRAINT "pairing_approval_result_request_fingerprint_check" CHECK (octet_length("pairing_approval_result"."request_fingerprint") = 32),
	CONSTRAINT "pairing_approval_result_response_check" CHECK (jsonb_typeof("pairing_approval_result"."response") = 'object' and pg_column_size("pairing_approval_result"."response") <= 8192),
	CONSTRAINT "pairing_approval_result_timestamps_check" CHECK ("pairing_approval_result"."expires_at" > "pairing_approval_result"."created_at")
);
--> statement-breakpoint
CREATE TABLE "pairing_request" (
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_authentication_tag" "bytea",
	"delivery_ciphertext" "bytea",
	"delivery_credential_version" integer,
	"delivery_envelope_version" integer,
	"delivery_nonce" "bytea",
	"device_id" text,
	"display_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"human_code_digest" "bytea" NOT NULL,
	"human_code_version" integer NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"next_poll_at" timestamp with time zone NOT NULL,
	"polling_token_digest" "bytea" NOT NULL,
	"polling_token_version" integer NOT NULL,
	"retained_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	CONSTRAINT "pairing_request_id_check" CHECK (char_length("pairing_request"."id") between 1 and 256),
	CONSTRAINT "pairing_request_display_name_check" CHECK (char_length("pairing_request"."display_name") between 1 and 256),
	CONSTRAINT "pairing_request_human_code_version_check" CHECK ("pairing_request"."human_code_version" > 0),
	CONSTRAINT "pairing_request_human_code_digest_check" CHECK (octet_length("pairing_request"."human_code_digest") = 32),
	CONSTRAINT "pairing_request_polling_token_version_check" CHECK ("pairing_request"."polling_token_version" > 0),
	CONSTRAINT "pairing_request_polling_token_digest_check" CHECK (octet_length("pairing_request"."polling_token_digest") = 32),
	CONSTRAINT "pairing_request_timestamps_check" CHECK ("pairing_request"."expires_at" > "pairing_request"."created_at" and "pairing_request"."next_poll_at" > "pairing_request"."created_at" and "pairing_request"."next_poll_at" <= "pairing_request"."expires_at" and "pairing_request"."retained_until" >= "pairing_request"."expires_at"),
	CONSTRAINT "pairing_request_approval_state_check" CHECK (("pairing_request"."status" = 'pending' and "pairing_request"."approved_at" is null and "pairing_request"."device_id" is null) or ("pairing_request"."status" = 'approved' and "pairing_request"."approved_at" is not null and "pairing_request"."approved_at" < "pairing_request"."expires_at" and "pairing_request"."device_id" is not null)),
	CONSTRAINT "pairing_request_delivery_completeness_check" CHECK (num_nonnulls("pairing_request"."delivery_envelope_version", "pairing_request"."delivery_credential_version", "pairing_request"."delivery_nonce", "pairing_request"."delivery_ciphertext", "pairing_request"."delivery_authentication_tag") in (0, 5)),
	CONSTRAINT "pairing_request_delivery_approval_check" CHECK ("pairing_request"."delivery_envelope_version" is null or "pairing_request"."status" = 'approved'),
	CONSTRAINT "pairing_request_delivery_envelope_version_check" CHECK ("pairing_request"."delivery_envelope_version" is null or "pairing_request"."delivery_envelope_version" > 0),
	CONSTRAINT "pairing_request_delivery_credential_version_check" CHECK ("pairing_request"."delivery_credential_version" is null or "pairing_request"."delivery_credential_version" > 0),
	CONSTRAINT "pairing_request_delivery_nonce_check" CHECK ("pairing_request"."delivery_nonce" is null or octet_length("pairing_request"."delivery_nonce") = 12),
	CONSTRAINT "pairing_request_delivery_ciphertext_check" CHECK ("pairing_request"."delivery_ciphertext" is null or octet_length("pairing_request"."delivery_ciphertext") between 1 and 4096),
	CONSTRAINT "pairing_request_delivery_authentication_tag_check" CHECK ("pairing_request"."delivery_authentication_tag" is null or octet_length("pairing_request"."delivery_authentication_tag") = 16)
);
--> statement-breakpoint
ALTER TABLE "device_credential" ADD CONSTRAINT "device_credential_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_approval_result" ADD CONSTRAINT "pairing_approval_result_administrator_user_id_user_id_fk" FOREIGN KEY ("administrator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_approval_result" ADD CONSTRAINT "pairing_approval_result_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairing_request" ADD CONSTRAINT "pairing_request_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_credential_version_verifier_unique" ON "device_credential" USING btree ("version","verifier");--> statement-breakpoint
CREATE INDEX "pairing_approval_result_expiry_cleanup_index" ON "pairing_approval_result" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_request_human_code_digest_unique" ON "pairing_request" USING btree ("human_code_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_request_polling_token_digest_unique" ON "pairing_request" USING btree ("polling_token_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_request_device_id_unique" ON "pairing_request" USING btree ("device_id") WHERE "pairing_request"."device_id" is not null;--> statement-breakpoint
CREATE INDEX "pairing_request_delivery_cleanup_index" ON "pairing_request" USING btree ("expires_at") WHERE "pairing_request"."delivery_envelope_version" is not null;--> statement-breakpoint
CREATE INDEX "pairing_request_retention_cleanup_index" ON "pairing_request" USING btree ("retained_until");