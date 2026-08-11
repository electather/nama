import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthService } from "@nama/api/nama/api/v1/auth_pb.js";
import { DeviceService } from "@nama/api/nama/api/v1/device_pb.js";
import { HealthService } from "@nama/api/nama/api/v1/health_pb.js";
import { ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { SetupService } from "@nama/api/nama/api/v1/setup_pb.js";
import { SyncService } from "@nama/api/nama/api/v1/sync_pb.js";

import { contractAuthorityByMethod } from "./contract-authorization.ts";

const managementServices = [
  AuthService,
  DeviceService,
  HealthService,
  ProviderService,
  SetupService,
  SyncService,
] as const;

void test("every management method has an explicit authority", () => {
  const managementMethods: string[] = [];

  for (const service of managementServices) {
    for (const method of Object.values(service.methods)) {
      managementMethods.push(`${service.typeName}.${method.name}`);
    }
  }

  assert.deepEqual(Object.keys(contractAuthorityByMethod).toSorted(), managementMethods.toSorted());
});
