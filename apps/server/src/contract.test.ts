// oxlint-disable import/max-dependencies -- This completeness test intentionally imports every public service descriptor.
import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { DeviceService } from "@nama/api/nama/api/v1/device_pb.js";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { LibraryService } from "@nama/api/nama/api/v1/library_pb.js";
import { PlaybackService } from "@nama/api/nama/api/v1/playback_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";
import { UserStateService } from "@nama/api/nama/api/v1/user_state_pb.js";

import { contractAuthorityByMethod } from "./contract-authorization.ts";

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

void test("every public method has an explicit authority", () => {
  const publicMethods: string[] = [];

  for (const service of publicServices) {
    for (const method of Object.values(service.methods)) {
      publicMethods.push(`${service.typeName}.${method.name}`);
    }
  }

  assert.deepEqual(Object.keys(contractAuthorityByMethod).toSorted(), publicMethods.toSorted());
});
