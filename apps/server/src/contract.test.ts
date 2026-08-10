import assert from "node:assert/strict";
import test from "node:test";

import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
// Generated schemas.
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
// Authentication schemas.
import {
  AuthService,
  GetCurrentUserRequestSchema,
  SignInResponseSchema,
  SignOutRequestSchema,
  SignOutResponseSchema,
} from "@nama/api/nama/api/v1/auth_pb.js";
import {
  BearerCredentialSchema,
  HttpHeaderSchema as PublicHttpHeaderSchema,
} from "@nama/api/nama/api/v1/common_pb.js";
import {
  CheckResponseSchema,
  GetDiagnosticsResponseSchema,
  HealthService,
  ServingStatus,
} from "@nama/api/nama/api/v1/health_pb.js";
// Setup schemas.
import {
  AdministratorSchema,
  CreateAdministratorResponseSchema,
  GetStatusRequestSchema,
  SetupService,
} from "@nama/api/nama/api/v1/setup_pb.js";
import { HttpHeaderSchema as PluginHttpHeaderSchema } from "@nama/api/nama/plugin/v1/common_pb.js";

const assertRoundTrip = <Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): void => {
  assert.deepEqual(fromBinary(schema, toBinary(schema, message)), message);
};

void test("common messages round-trip across both Nama packages", () => {
  const publicHeader = create(PublicHttpHeaderSchema, { name: "x-test", value: "public" });
  const pluginHeader = create(PluginHttpHeaderSchema, { name: "x-test", value: "plugin" });
  const credential = create(BearerCredentialSchema, {
    expiresAt: { nanos: 0, seconds: 1n },
    token: "opaque",
  });
  assertRoundTrip(PublicHttpHeaderSchema, publicHeader);
  assertRoundTrip(PluginHttpHeaderSchema, pluginHeader);
  assertRoundTrip(BearerCredentialSchema, credential);
});

void test("selected google.rpc details compile and round-trip", () => {
  assertRoundTrip(
    ErrorInfoSchema,
    create(ErrorInfoSchema, { domain: "nama.api.v1", reason: "TEST" }),
  );
  assertRoundTrip(
    BadRequestSchema,
    create(BadRequestSchema, {
      fieldViolations: [{ description: "invalid", field: "field", reason: "REQUIRED" }],
    }),
  );
  assertRoundTrip(RequestInfoSchema, create(RequestInfoSchema, { requestId: "request-1" }));
  assertRoundTrip(
    RetryInfoSchema,
    create(RetryInfoSchema, { retryDelay: { nanos: 0, seconds: 1n } }),
  );
});

void test("operator health and ordered diagnostics round-trip", () => {
  assertRoundTrip(
    CheckResponseSchema,
    create(CheckResponseSchema, {
      databaseStatus: ServingStatus.SERVING,
      initialized: true,
      ready: true,
      serverVersion: "0.1.0",
      status: ServingStatus.SERVING,
    }),
  );

  const diagnostics = create(GetDiagnosticsResponseSchema, {
    components: [
      {
        checkedAt: { nanos: 0, seconds: 1n },
        name: "core",
        status: ServingStatus.SERVING,
        summary: "ready",
      },
      {
        checkedAt: { nanos: 0, seconds: 2n },
        name: "database",
        status: ServingStatus.SERVING,
        summary: "connected",
      },
      {
        checkedAt: { nanos: 0, seconds: 3n },
        name: "provider_instance/opaque-id",
        status: ServingStatus.NOT_SERVING,
        summary: "unavailable",
      },
    ],
    requestId: "request-1",
    serverVersion: "0.1.0",
  });
  const decoded = fromBinary(
    GetDiagnosticsResponseSchema,
    toBinary(GetDiagnosticsResponseSchema, diagnostics),
  );
  assert.deepEqual(decoded, diagnostics);
  const componentNames: string[] = [];
  for (const component of decoded.components) {
    componentNames.push(component.name);
  }

  assert.deepEqual(componentNames, ["core", "database", "provider_instance/opaque-id"]);
  assert.equal(HealthService.method.check.name, "Check");
  assert.equal(HealthService.method.getDiagnostics.name, "GetDiagnostics");
});

void test("setup contracts round-trip", () => {
  const administrator = create(AdministratorSchema, {
    displayName: "Admin",
    email: "admin@example.com",
    id: "administrator-1",
  });
  assertRoundTrip(AdministratorSchema, administrator);
  assertRoundTrip(
    CreateAdministratorResponseSchema,
    create(CreateAdministratorResponseSchema, { administrator }),
  );

  create(GetStatusRequestSchema);
  assert.equal(SetupService.method.getStatus.name, "GetStatus");
  assert.equal(SetupService.method.createAdministrator.name, "CreateAdministrator");
});

void test("authentication contracts round-trip", () => {
  const administrator = create(AdministratorSchema, {
    displayName: "Admin",
    email: "admin@example.com",
    id: "administrator-1",
  });
  assertRoundTrip(
    SignInResponseSchema,
    create(SignInResponseSchema, {
      administrator,
      credential: { expiresAt: { nanos: 0, seconds: 60n }, token: "opaque" },
    }),
  );

  create(GetCurrentUserRequestSchema);
  create(SignOutRequestSchema);
  create(SignOutResponseSchema);
  assert.equal(AuthService.method.signIn.name, "SignIn");
  assert.equal(AuthService.method.getCurrentUser.name, "GetCurrentUser");
  assert.equal(AuthService.method.signOut.name, "SignOut");
});
