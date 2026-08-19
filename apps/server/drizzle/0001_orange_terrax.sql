CREATE TABLE "provider_credential" (
	"authentication_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"configuration_key" text NOT NULL,
	"envelope_version" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"provider_instance_id" text NOT NULL,
	CONSTRAINT "provider_credential_provider_instance_id_configuration_key_pk" PRIMARY KEY("provider_instance_id","configuration_key"),
	CONSTRAINT "provider_credential_configuration_key_check" CHECK (char_length("provider_credential"."configuration_key") between 1 and 256 and "provider_credential"."configuration_key" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
	CONSTRAINT "provider_credential_envelope_version_check" CHECK ("provider_credential"."envelope_version" > 0),
	CONSTRAINT "provider_credential_nonce_check" CHECK (octet_length("provider_credential"."nonce") = 12),
	CONSTRAINT "provider_credential_ciphertext_check" CHECK (octet_length("provider_credential"."ciphertext") <= 65536),
	CONSTRAINT "provider_credential_authentication_tag_check" CHECK (octet_length("provider_credential"."authentication_tag") = 16)
);
--> statement-breakpoint
CREATE TABLE "provider_installation" (
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"capabilities" jsonb NOT NULL,
	"configuration_schema" jsonb NOT NULL,
	"contract_major" integer NOT NULL,
	"description" text NOT NULL,
	"display_name" text NOT NULL,
	"plugin_build_version" text NOT NULL,
	"provider_type_id" text PRIMARY KEY NOT NULL,
	"schema_profile_version" integer NOT NULL,
	"schema_revision" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_installation_provider_type_id_check" CHECK (char_length("provider_installation"."provider_type_id") between 1 and 256),
	CONSTRAINT "provider_installation_display_name_check" CHECK (char_length("provider_installation"."display_name") between 1 and 256),
	CONSTRAINT "provider_installation_description_check" CHECK (char_length("provider_installation"."description") <= 1024),
	CONSTRAINT "provider_installation_plugin_build_version_check" CHECK (char_length("provider_installation"."plugin_build_version") between 1 and 256),
	CONSTRAINT "provider_installation_contract_major_check" CHECK ("provider_installation"."contract_major" > 0),
	CONSTRAINT "provider_installation_capabilities_check" CHECK (jsonb_typeof("provider_installation"."capabilities") = 'array' and jsonb_array_length("provider_installation"."capabilities") <= 32),
	CONSTRAINT "provider_installation_configuration_schema_check" CHECK (jsonb_typeof("provider_installation"."configuration_schema") = 'object' and jsonb_typeof("provider_installation"."configuration_schema" -> 'properties') = 'object' and jsonb_array_length(jsonb_path_query_array("provider_installation"."configuration_schema" -> 'properties', '$.keyvalue()')) <= 100),
	CONSTRAINT "provider_installation_schema_profile_version_check" CHECK ("provider_installation"."schema_profile_version" > 0),
	CONSTRAINT "provider_installation_schema_revision_check" CHECK (char_length("provider_installation"."schema_revision") between 1 and 256),
	CONSTRAINT "provider_installation_timestamps_check" CHECK ("provider_installation"."updated_at" >= "provider_installation"."accepted_at")
);
--> statement-breakpoint
CREATE TABLE "provider_instance" (
	"configuration" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"principal_digest" "bytea" NOT NULL,
	"provider_type_id" text NOT NULL,
	"revision" text NOT NULL,
	"sync_priority" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_instance_id_check" CHECK (char_length("provider_instance"."id") between 1 and 256),
	CONSTRAINT "provider_instance_display_name_check" CHECK (char_length("provider_instance"."display_name") between 1 and 256),
	CONSTRAINT "provider_instance_sync_priority_check" CHECK ("provider_instance"."sync_priority" between 1 and 4294967295),
	CONSTRAINT "provider_instance_configuration_check" CHECK (jsonb_typeof("provider_instance"."configuration") = 'object' and jsonb_array_length(jsonb_path_query_array("provider_instance"."configuration", '$.keyvalue()')) <= 100),
	CONSTRAINT "provider_instance_principal_digest_check" CHECK (octet_length("provider_instance"."principal_digest") = 32),
	CONSTRAINT "provider_instance_revision_check" CHECK (char_length("provider_instance"."revision") between 1 and 256),
	CONSTRAINT "provider_instance_timestamps_check" CHECK ("provider_instance"."updated_at" >= "provider_instance"."created_at")
);
--> statement-breakpoint
CREATE TABLE "provider_instance_observation" (
	"instance_revision" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_instance_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	CONSTRAINT "provider_instance_observation_revision_check" CHECK (char_length("provider_instance_observation"."instance_revision") between 1 and 256),
	CONSTRAINT "provider_instance_observation_status_check" CHECK ("provider_instance_observation"."status" in ('healthy', 'unavailable', 'authentication_failed')),
	CONSTRAINT "provider_instance_observation_summary_check" CHECK (char_length("provider_instance_observation"."summary") <= 1024)
);
--> statement-breakpoint
CREATE TABLE "provider_operation_result" (
	"administrator_user_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT transaction_timestamp() + interval '7 days' NOT NULL,
	"method" text NOT NULL,
	"operation_id" text NOT NULL,
	"request_fingerprint" "bytea" NOT NULL,
	"serialized_result" jsonb NOT NULL,
	CONSTRAINT "provider_operation_result_administrator_user_id_method_operation_id_pk" PRIMARY KEY("administrator_user_id","method","operation_id"),
	CONSTRAINT "provider_operation_result_method_check" CHECK ("provider_operation_result"."method" in ('nama.api.v1.ProviderService.CreateProviderInstance', 'nama.api.v1.ProviderService.UpdateProviderInstance', 'nama.api.v1.ProviderService.DeleteProviderInstance')),
	CONSTRAINT "provider_operation_result_operation_id_check" CHECK (char_length("provider_operation_result"."operation_id") between 1 and 256),
	CONSTRAINT "provider_operation_result_request_fingerprint_check" CHECK (octet_length("provider_operation_result"."request_fingerprint") = 32),
	CONSTRAINT "provider_operation_result_serialized_result_check" CHECK (jsonb_typeof("provider_operation_result"."serialized_result") = 'object'),
	CONSTRAINT "provider_operation_result_retention_check" CHECK ("provider_operation_result"."expires_at" >= "provider_operation_result"."completed_at" + interval '7 days')
);
--> statement-breakpoint
ALTER TABLE "provider_credential" ADD CONSTRAINT "provider_credential_provider_instance_id_provider_instance_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_instance" ADD CONSTRAINT "provider_instance_provider_type_id_provider_installation_provider_type_id_fk" FOREIGN KEY ("provider_type_id") REFERENCES "public"."provider_installation"("provider_type_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_instance_observation" ADD CONSTRAINT "provider_instance_observation_provider_instance_id_provider_instance_id_fk" FOREIGN KEY ("provider_instance_id") REFERENCES "public"."provider_instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operation_result" ADD CONSTRAINT "provider_operation_result_administrator_user_id_user_id_fk" FOREIGN KEY ("administrator_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_instance_enabled_sync_priority_unique" ON "provider_instance" USING btree ("sync_priority") WHERE "provider_instance"."enabled";--> statement-breakpoint
CREATE INDEX "provider_operation_result_expires_at_index" ON "provider_operation_result" USING btree ("expires_at");
--> statement-breakpoint
CREATE FUNCTION nama_assert_provider_instance_secret_partition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	provider_schema jsonb;
BEGIN
	SELECT configuration_schema
	INTO provider_schema
	FROM provider_installation
	WHERE provider_type_id = NEW.provider_type_id;

	IF provider_schema IS NOT NULL AND EXISTS (
		SELECT 1
		FROM jsonb_each(COALESCE(provider_schema -> 'properties', '{}'::jsonb)) AS property
		WHERE property.value -> 'writeOnly' = 'true'::jsonb
			AND NEW.configuration ? property.key
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider configuration violates secret partition';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_instance_secret_partition_trigger
BEFORE INSERT OR UPDATE OF configuration, provider_type_id
ON provider_instance
FOR EACH ROW
EXECUTE FUNCTION nama_assert_provider_instance_secret_partition();
--> statement-breakpoint
CREATE FUNCTION nama_assert_provider_credential_classification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	property_schema jsonb;
BEGIN
	SELECT installation.configuration_schema -> 'properties' -> NEW.configuration_key
	INTO property_schema
	FROM provider_instance AS instance
	INNER JOIN provider_installation AS installation
		ON installation.provider_type_id = instance.provider_type_id
	WHERE instance.id = NEW.provider_instance_id;

	IF property_schema IS NULL
		OR property_schema ->> 'type' IS DISTINCT FROM 'string'
		OR property_schema -> 'writeOnly' IS DISTINCT FROM 'true'::jsonb
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider credential classification invalid';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_credential_classification_trigger
BEFORE INSERT OR UPDATE OF provider_instance_id, configuration_key
ON provider_credential
FOR EACH ROW
EXECUTE FUNCTION nama_assert_provider_credential_classification();
--> statement-breakpoint
CREATE FUNCTION nama_assert_provider_instance_binding_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.provider_type_id IS DISTINCT FROM OLD.provider_type_id
		OR NEW.principal_digest IS DISTINCT FROM OLD.principal_digest
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider instance binding is immutable';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_instance_binding_immutable_trigger
BEFORE UPDATE OF id, provider_type_id, principal_digest, created_at
ON provider_instance
FOR EACH ROW
EXECUTE FUNCTION nama_assert_provider_instance_binding_immutable();
--> statement-breakpoint
CREATE FUNCTION nama_assert_provider_secret_classification_monotonic()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	old_properties jsonb := COALESCE(OLD.configuration_schema -> 'properties', '{}'::jsonb);
	new_properties jsonb := COALESCE(NEW.configuration_schema -> 'properties', '{}'::jsonb);
BEGIN
	IF EXISTS (
		SELECT 1
		FROM jsonb_each(old_properties) AS property
		WHERE property.value -> 'writeOnly' = 'true'::jsonb
			AND (
				NOT new_properties ? property.key
				OR new_properties -> property.key -> 'writeOnly'
					IS DISTINCT FROM 'true'::jsonb
				OR new_properties -> property.key ->> 'type'
					IS DISTINCT FROM property.value ->> 'type'
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider secret classification is monotonic';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM jsonb_each(new_properties) AS property
		WHERE property.value -> 'writeOnly' = 'true'::jsonb
			AND old_properties -> property.key -> 'writeOnly'
				IS DISTINCT FROM 'true'::jsonb
			AND EXISTS (
				SELECT 1
				FROM provider_instance AS instance
				WHERE instance.provider_type_id = OLD.provider_type_id
					AND instance.configuration ? property.key
			)
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'stored provider configuration conflicts with secret classification';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_secret_classification_monotonic_trigger
BEFORE UPDATE OF configuration_schema
ON provider_installation
FOR EACH ROW
EXECUTE FUNCTION nama_assert_provider_secret_classification_monotonic();
--> statement-breakpoint
CREATE FUNCTION nama_enforce_provider_instance_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM 1
	FROM nama_server_state
	WHERE key = 'server'
	FOR UPDATE;

	IF (SELECT count(*) FROM provider_instance) >= 100 THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider instance limit exceeded';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_instance_limit_trigger
BEFORE INSERT
ON provider_instance
FOR EACH ROW
EXECUTE FUNCTION nama_enforce_provider_instance_limit();
--> statement-breakpoint
CREATE FUNCTION nama_assert_provider_observation_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM 1
	FROM provider_instance
	WHERE id = NEW.provider_instance_id
		AND revision = NEW.instance_revision
	FOR SHARE;

	IF NOT FOUND THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'provider observation revision is not current';
	END IF;

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER provider_observation_revision_trigger
BEFORE INSERT OR UPDATE OF provider_instance_id, instance_revision
ON provider_instance_observation
FOR EACH ROW
EXECUTE FUNCTION nama_assert_provider_observation_revision();