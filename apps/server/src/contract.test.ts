// oxlint-disable import/max-dependencies, eslint/max-lines-per-function, eslint/max-statements, eslint/sort-imports, typescript/prefer-readonly-parameter-types -- Contract tests keep generated imports and literal expectations beside their behavior.
import assert from "node:assert/strict";
import { test } from "node:test";

import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { DeviceService } from "@nama/api/nama/api/v1/device_pb.js";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/api/v1/library_pb.js";
import {
  PlaybackService,
  PlaybackPreferencesSchema as PublicPlaybackPreferencesSchema,
  PlaybackQuality as PublicPlaybackQuality,
  SubtitlePreference as PublicSubtitlePreference,
} from "@nama/api/nama/api/v1/playback_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { UserStateService } from "@nama/api/nama/api/v1/user_state_pb.js";
import { HealthService as PluginHealthService } from "@nama/api/nama/plugin/v1/health_pb.js";
import { LibraryService as PluginLibraryService } from "@nama/api/nama/plugin/v1/library_pb.js";
import {
  PlaybackPreferencesSchema as PluginPlaybackPreferencesSchema,
  PlaybackQuality as PluginPlaybackQuality,
  PlaybackService as PluginPlaybackService,
  SubtitlePreference as PluginSubtitlePreference,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import { PluginService } from "@nama/api/nama/plugin/v1/plugin_pb.js";
import { WatchStateService as PluginWatchStateService } from "@nama/api/nama/plugin/v1/watch_state_pb.js";

import { contractAuthorityByMethod } from "./contract-authorization.ts";
import { normalizeContractFieldErrors } from "./contract-errors.ts";

const publicServices = [
  AuthService,
  DeviceService,
  HealthService,
  LibraryService,
  PlaybackService,
  ProviderService,
  SetupService,
  SyncService,
  UserStateService,
] as const;

const pluginServices = [
  PluginHealthService,
  PluginLibraryService,
  PluginPlaybackService,
  PluginService,
  PluginWatchStateService,
] as const;

void test("every generated method has exactly one explicit authority", () => {
  const generatedMethods: string[] = [];
  const pluginMethods: string[] = [];

  for (const service of [...publicServices, ...pluginServices]) {
    for (const method of Object.values(service.methods)) {
      generatedMethods.push(`${service.typeName}.${method.name}`);
    }
  }

  for (const service of pluginServices) {
    for (const method of Object.values(service.methods)) {
      pluginMethods.push(`${service.typeName}.${method.name}`);
    }
  }

  assert.deepEqual(Object.keys(contractAuthorityByMethod).toSorted(), generatedMethods.toSorted());
  for (const method of pluginMethods) {
    assert.equal(Reflect.get(contractAuthorityByMethod, method), "plugin-bearer");
  }
  assert.equal(
    Reflect.get(contractAuthorityByMethod, "nama.api.v1.UnknownService.UnknownMethod"),
    undefined,
  );
});

void test("both playback preference schemas execute the CAPPED bit-rate rule", () => {
  const validator = createValidator();

  for (const { schema, capped, automatic, original, subtitleAuto } of [
    {
      automatic: PublicPlaybackQuality.AUTO,
      capped: PublicPlaybackQuality.CAPPED,
      original: PublicPlaybackQuality.ORIGINAL,
      schema: PublicPlaybackPreferencesSchema,
      subtitleAuto: PublicSubtitlePreference.AUTO,
    },
    {
      automatic: PluginPlaybackQuality.AUTO,
      capped: PluginPlaybackQuality.CAPPED,
      original: PluginPlaybackQuality.ORIGINAL,
      schema: PluginPlaybackPreferencesSchema,
      subtitleAuto: PluginSubtitlePreference.AUTO,
    },
  ]) {
    assert.equal(
      validator.validate(
        schema,
        create(schema, { maxBitRateBps: 1n, quality: capped, subtitlePreference: subtitleAuto }),
      ).kind,
      "valid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { quality: capped, subtitlePreference: subtitleAuto }),
      ).kind,
      "invalid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { maxBitRateBps: 0n, quality: capped, subtitlePreference: subtitleAuto }),
      ).kind,
      "invalid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { maxBitRateBps: 1n, quality: automatic, subtitlePreference: subtitleAuto }),
      ).kind,
      "invalid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { maxBitRateBps: 1n, quality: original, subtitlePreference: subtitleAuto }),
      ).kind,
      "invalid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { quality: automatic, subtitlePreference: subtitleAuto }),
      ).kind,
      "valid",
    );
    assert.equal(
      validator.validate(
        schema,
        create(schema, { quality: original, subtitlePreference: subtitleAuto }),
      ).kind,
      "valid",
    );
  }
});

const approvedViolations = [
  {
    description: "cannot clear a field also present in configuration_patch",
    field: "clear_configuration_fields[0]",
    reason: "CONFLICT",
  },
  {
    description: "required by the selected provider schema",
    field: "configuration.api_key",
    reason: "REQUIRED",
  },
  {
    description: "must be an absolute HTTP or HTTPS URL",
    field: "configuration.base_url",
    localizedMessage: { locale: "en", message: "Enter a valid server URL." },
    reason: "INVALID_FORMAT",
  },
  {
    description: "cannot set a field also present in clear_configuration_fields",
    field: "configuration_patch.api_key",
    reason: "CONFLICT",
  },
  {
    description: "must be positive when quality is CAPPED",
    field: "max_bit_rate_bps",
    reason: "MISMATCH",
  },
  {
    description: "must omit max_bit_rate_bps unless quality is CAPPED",
    field: "quality",
    reason: "MISMATCH",
  },
] as const;

const FIELD_ERROR_LIMIT = 50;
const FIELD_ERROR_INPUT_COUNT = 51;
const FIELD_NUMBER_WIDTH = 2;

void test("field errors are sorted, copied, and stripped of private metadata", () => {
  const reversedViolations = structuredClone(approvedViolations.toReversed()).map((violation) =>
    Object.assign(violation, { providerReference: "private" }),
  );
  const inputSnapshot = structuredClone(reversedViolations);

  const result = normalizeContractFieldErrors(reversedViolations);

  assert.deepEqual(result, approvedViolations);
  assert.deepEqual(reversedViolations, inputSnapshot);

  for (const error of result) {
    const source = reversedViolations.find((violation) => violation.field === error.field);
    assert.ok(source);
    assert.notStrictEqual(error, source);
    if (error.localizedMessage) {
      assert.deepEqual(Object.keys(error).toSorted(), [
        "description",
        "field",
        "localizedMessage",
        "reason",
      ]);
      assert.ok("localizedMessage" in source);
      assert.notStrictEqual(error.localizedMessage, source.localizedMessage);
      assert.deepEqual(Object.keys(error.localizedMessage).toSorted(), ["locale", "message"]);
    } else {
      assert.deepEqual(Object.keys(error).toSorted(), ["description", "field", "reason"]);
    }
  }
});

void test("field errors retain only the first 50 sorted entries", () => {
  const reversedViolations = Array.from({ length: FIELD_ERROR_INPUT_COUNT }, (_unused, index) => {
    const fieldNumber = FIELD_ERROR_LIMIT - index;
    return {
      description: `description ${fieldNumber}`,
      field: `field_${fieldNumber.toString().padStart(FIELD_NUMBER_WIDTH, "0")}`,
      providerReference: `private ${fieldNumber}`,
      reason: "INVALID_FORMAT",
    };
  });

  const result = normalizeContractFieldErrors(reversedViolations);

  assert.equal(result.length, FIELD_ERROR_LIMIT);
  assert.deepEqual(
    result.map(({ field }) => field),
    Array.from(
      { length: FIELD_ERROR_LIMIT },
      (_unused, index) => `field_${index.toString().padStart(FIELD_NUMBER_WIDTH, "0")}`,
    ),
  );
  assert.equal(
    result.some(({ field }) => field === "field_50"),
    false,
  );
});
