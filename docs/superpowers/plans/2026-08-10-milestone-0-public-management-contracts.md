# Milestone 0 Public Management Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the complete provider-neutral public management contract for health, setup, authentication, devices, provider instances, and synchronization.

**Architecture:** Domain-oriented unary services live in `nama.api.v1`. Management clients receive Nama-owned resources, schema-driven provider configuration, standard Google RPC error details, and stable opaque identifiers; Better Auth and provider wire types remain private implementation details.

**Tech Stack:** Protobuf, Protovalidate annotations, Buf, ConnectRPC generated clients, TypeScript/Protobuf-ES, Go, SwiftProtobuf/Connect-Swift.

## Global Constraints

- This is plan 2 of 4 and depends on `2026-08-10-milestone-0-contract-toolchain.md` being complete.
- Milestone 0 defines wire schemas and contract checks only. Do not add handlers, persistence, authentication adapters, CLI commands, or fake runtime behavior.
- Preserve all existing health field and enum numbers. Assign every new field and enum value exactly as listed here; these numbers become immutable when the complete v1 surface merges.
- Every request and response has a method-specific message, including empty messages. Do not use `google.protobuf.Empty`.
- All identifiers are opaque strings. Public messages may expose `provider_type_id` and `provider_instance_id` as Nama-managed resources, but never remote provider item IDs, stream indexes, SDK types, raw errors, or reusable provider credentials.
- Provider configuration is `google.protobuf.Struct` conforming to the restricted profile in `docs/architecture/api-contracts.md`; do not encode a Jellyfin or Plex field in Protobuf.
- Write-only provider secrets are accepted in configuration writes and returned only as configured markers.
- Use the structural bounds established in plan 1. Apply method-specific limits of 100 to page sizes, provider-instance count, and ordinary returned collections; diagnostics are the one complete bounded response of at most 102 components.
- Structural validation belongs in Protovalidate. State, ownership, revision, idempotency, provider-schema, and cross-resource rules remain documented semantics for later handlers.
- Required enum fields use `(buf.validate.field).enum = { not_in: [0] }`; never use `defined_only`, because unknown future numeric values must remain valid.
- Every present Timestamp carries `(buf.validate.field).timestamp = {}`. Every present Duration is non-negative with `(buf.validate.field).duration.gte = {}`; pairing `poll_interval` is required, strictly positive with `.duration.gt = {}`, and at most 60 seconds with `.duration.lte = { seconds: 60 }`.
- Regenerate after every schema slice. Never edit generated files by hand.

### Wire Type Key

Field tables below fix tags by left-to-right order. Unless a row names a message type explicitly, use these exact protobuf types:

- `string`: `id`, `name`, `summary`, `description`, `email`, `password`, `key`, `revision`, every field ending in `_id`, `_token`, `_code`, `_name`, `_revision`, `_summary`, `_description`, `_email`, `_password`, `_key`, `_label`, or `_field`, plus `server_version`, `remote_version`, `page_token`, `next_page_token`, `expected_revision`, and `provider_user_reference`.
- `bool`: `initialized`, `ready`, `enabled`, `configured`, and `revoked`.
- `uint32`: `page_size`, `sync_priority`, and `schema_profile_version`.
- `uint64`: every field in `SyncCounts`.
- `google.protobuf.Timestamp`: every field ending in `_at`.
- `google.protobuf.Duration`: `poll_interval`.
- `google.protobuf.Struct`: `configuration_schema`, `configuration`, and `configuration_patch`.
- The declared enum type: `status`, `database_status`, `aggregate_status`, `phase`, and each repeated `capabilities` value.
- Message fields map exactly as follows: `administrator` → `Administrator`; `credential` → `BearerCredential`; `device`/`devices` → `Device`; `provider_type`/`provider_types` → `ProviderType`; `provider_instance`/`provider_instances` → `ProviderInstance`; `configured_secrets` → `ConfiguredSecret`; Provider RPC `result` → `ProviderConnectionTest`; `counts` → `SyncCounts`; `child_runs` → `SyncChildRunReference`; `run`/`active_run` → `SyncRun`; `provider_statuses` → `ProviderSyncStatus`; and `components` → `DiagnosticComponent`.
- `clear_configuration_fields` is `repeated string`.
- Every remaining scalar field is `string`; do not infer another wire type from a sample value.

An `optional` marker in a table means proto3 explicit presence for a scalar/enum. Message fields already have presence; “required” means attach `(buf.validate.field).required = true`.

---

### Task 1: Extend HealthService without breaking its anchor

**Files:**

- Modify: `proto/nama/api/v1/health.proto`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: existing `ServingStatus`, `CheckRequest`, `CheckResponse.status = 1`, and `HealthService.Check`.
- Produces: additive operator health fields and deterministic diagnostics messages/RPC.

- [ ] **Step 1: Add the exact health declarations**

Keep existing declarations in place and add these tags:

```proto
message CheckResponse {
  ServingStatus status = 1 [(buf.validate.field).enum = {
    not_in: [0]
  }];
  string server_version = 2;
  bool initialized = 3;
  bool ready = 4;
  ServingStatus database_status = 5 [(buf.validate.field).enum = {
    not_in: [0]
  }];
}

message DiagnosticComponent {
  string name = 1;
  ServingStatus status = 2 [(buf.validate.field).enum = {
    not_in: [0]
  }];
  string summary = 3;
  google.protobuf.Timestamp checked_at = 4;
}

message GetDiagnosticsRequest {}

message GetDiagnosticsResponse {
  string server_version = 1;
  string request_id = 2;
  repeated DiagnosticComponent components = 3;
}

service HealthService {
  rpc Check(CheckRequest) returns (CheckResponse);
  rpc GetDiagnostics(GetDiagnosticsRequest) returns (GetDiagnosticsResponse);
}
```

Import Timestamp and Protovalidate. Attach `(buf.validate.field).enum = { not_in: [0] }` to `CheckResponse.status`, `CheckResponse.database_status`, and `DiagnosticComponent.status`. Require non-empty bounded version, component name, summary, and request ID; require timestamps; constrain components to 2–102 because core and database are always present.

- [ ] **Step 2: Generate the additive health clients**

Run: `mise run generate`

Expected: generated public clients now contain the additive fields and `GetDiagnostics`.

- [ ] **Step 3: Run the health schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 4: Commit the health slice**

```bash
git add proto/nama/api/v1/health.proto gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add operator diagnostics contract"
```

### Task 2: Add setup and authentication contracts

**Files:**

- Create: `proto/nama/api/v1/setup.proto`
- Create: `proto/nama/api/v1/auth.proto`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: `nama.api.v1.BearerCredential` from `common.proto`.
- Produces: `Administrator`, `SetupService`, and `AuthService` with no Better Auth types on the wire.

- [ ] **Step 1: Create `setup.proto` with sequential tags**

Use this service exactly:

```proto
service SetupService {
  rpc GetStatus(GetStatusRequest) returns (GetStatusResponse);
  rpc CreateAdministrator(CreateAdministratorRequest) returns (CreateAdministratorResponse);
}
```

Declare fields in this order, assigning tags from 1:

| Message | Fields in tag order |
| --- | --- |
| `Administrator` | `id`, `display_name`, `email` |
| `GetStatusRequest` | no fields |
| `GetStatusResponse` | `initialized` |
| `CreateAdministratorRequest` | `bootstrap_token`, `display_name`, `email`, `password` |
| `CreateAdministratorResponse` | required `administrator` |

Validate email with the Protovalidate email rule and a 320-character maximum. Bound display name to 1–256, password to 1–1024, and bootstrap token to the secret-token bound. Never attach a rule that echoes either secret.

- [ ] **Step 2: Create `auth.proto` with sequential tags**

Import `common.proto` and `setup.proto`, then declare:

```proto
service AuthService {
  rpc SignIn(SignInRequest) returns (SignInResponse);
  rpc GetCurrentUser(GetCurrentUserRequest) returns (GetCurrentUserResponse);
  rpc SignOut(SignOutRequest) returns (SignOutResponse);
}
```

| Message | Fields in tag order |
| --- | --- |
| `SignInRequest` | `email`, `password` |
| `SignInResponse` | required `administrator`, required `credential` |
| `GetCurrentUserRequest` | no fields |
| `GetCurrentUserResponse` | required `administrator` |
| `SignOutRequest` | no fields |
| `SignOutResponse` | no fields |

Use the same email/password constraints as setup. Do not add cookies, refresh tokens, session IDs, or Better Auth messages.

- [ ] **Step 3: Generate the setup/auth clients**

Run: `mise run generate`

- [ ] **Step 4: Prove all public applications compile with setup/auth**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 5: Commit the setup/auth slice**

```bash
git add proto/nama/api/v1/setup.proto proto/nama/api/v1/auth.proto gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add setup and auth contracts"
```

### Task 3: Add device pairing and revocation contracts

**Files:**

- Create: `proto/nama/api/v1/device.proto`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: `BearerCredential` and common time/duration types.
- Produces: short-code approval separated from the high-entropy polling secret and revocable device credentials.

- [ ] **Step 1: Define enum and resource numbers**

```proto
enum PairingStatus {
  PAIRING_STATUS_UNSPECIFIED = 0;
  PAIRING_STATUS_PENDING = 1;
  PAIRING_STATUS_APPROVED = 2;
  PAIRING_STATUS_EXPIRED = 3;
}
```

Declare `Device` fields in tag order: `id = 1`, `display_name = 2`, required `created_at = 3`, optional `last_seen_at = 4`, `revoked = 5`, optional `revoked_at = 6`. Require every present Timestamp to be valid; do not add wrapper types.

- [ ] **Step 2: Define method messages and service**

```proto
service DeviceService {
  rpc BeginPairing(BeginPairingRequest) returns (BeginPairingResponse);
  rpc GetPairingStatus(GetPairingStatusRequest) returns (GetPairingStatusResponse);
  rpc ApprovePairing(ApprovePairingRequest) returns (ApprovePairingResponse);
  rpc ListDevices(ListDevicesRequest) returns (ListDevicesResponse);
  rpc RevokeDevice(RevokeDeviceRequest) returns (RevokeDeviceResponse);
}
```

| Message | Fields in tag order |
| --- | --- |
| `BeginPairingRequest` | `display_name` |
| `BeginPairingResponse` | `pairing_id`, `user_code`, `polling_token`, required `expires_at`, required `poll_interval` |
| `GetPairingStatusRequest` | `pairing_id`, `polling_token` |
| `GetPairingStatusResponse` | `status`, optional `device`, optional `credential` |
| `ApprovePairingRequest` | `operation_id`, `user_code` |
| `ApprovePairingResponse` | required `device` |
| `ListDevicesRequest` | `page_size`, `page_token` |
| `ListDevicesResponse` | repeated `devices`, `next_page_token` |
| `RevokeDeviceRequest` | `device_id` |
| `RevokeDeviceResponse` | required `device` |

Bound the human code to 6–32 characters. Attach `(buf.validate.field).required = true` to both pairing time messages, require a valid expiry Timestamp, and constrain `poll_interval` with duration `gt: {}` and `lte: { seconds: 60 }`. Cap list devices and page size at 100. Keep denial and an administrator-supplied polling ID out of the schema.

- [ ] **Step 3: Generate the device contract**

Run: `mise run generate`

- [ ] **Step 4: Validate the device schema and applications**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 5: Commit the device contract**

```bash
git add proto/nama/api/v1/device.proto gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add device pairing contract"
```

### Task 4: Add neutral schema-driven provider management

**Files:**

- Create: `proto/nama/api/v1/provider.proto`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: `google.protobuf.Struct`, Timestamp, and public common types.
- Produces: provider-type discovery and optimistic-concurrency instance management without provider-specific endpoints.

- [ ] **Step 1: Declare provider enums with fixed values**

```proto
enum ProviderCapability {
  PROVIDER_CAPABILITY_UNSPECIFIED = 0;
  PROVIDER_CAPABILITY_LIBRARY_READ = 1;
  PROVIDER_CAPABILITY_ARTWORK_RESOLVE = 2;
  PROVIDER_CAPABILITY_PLAYBACK_PLAN = 3;
  PROVIDER_CAPABILITY_PLAYBACK_OPEN = 4;
  PROVIDER_CAPABILITY_PLAYBACK_REPORT = 5;
  PROVIDER_CAPABILITY_PLAYBACK_REPORTS_USER_STATE = 6;
  PROVIDER_CAPABILITY_WATCH_STATE_READ = 7;
  PROVIDER_CAPABILITY_WATCHED_WRITE = 8;
  PROVIDER_CAPABILITY_PROGRESS_WRITE = 9;
}

enum ProviderInstanceStatus {
  PROVIDER_INSTANCE_STATUS_UNSPECIFIED = 0;
  PROVIDER_INSTANCE_STATUS_HEALTHY = 1;
  PROVIDER_INSTANCE_STATUS_UNAVAILABLE = 2;
  PROVIDER_INSTANCE_STATUS_AUTHENTICATION_FAILED = 3;
  PROVIDER_INSTANCE_STATUS_DISABLED = 4;
}

enum ProviderConnectionStatus {
  PROVIDER_CONNECTION_STATUS_UNSPECIFIED = 0;
  PROVIDER_CONNECTION_STATUS_CONNECTED = 1;
  PROVIDER_CONNECTION_STATUS_AUTHENTICATION_FAILED = 2;
  PROVIDER_CONNECTION_STATUS_UNREACHABLE = 3;
  PROVIDER_CONNECTION_STATUS_INCOMPATIBLE = 4;
}
```

- [ ] **Step 2: Declare provider resources with sequential tags**

| Message | Fields in tag order |
| --- | --- |
| `ProviderType` | `id`, `display_name`, `description`, repeated `capabilities`, required `configuration_schema`, `schema_profile_version`, `schema_revision` |
| `ConfiguredSecret` | `key`, `configured` |
| `ProviderInstance` | `id`, `provider_type_id`, `display_name`, `enabled`, `sync_priority`, `status`, required `configuration`, repeated `configured_secrets`, `revision`, required `created_at`, required `updated_at` |
| `ProviderConnectionTest` | `status`, `summary`, optional `remote_name`, optional `remote_version`, repeated `capabilities` |

Constrain priorities to positive `uint32`, provider/schema IDs to the opaque-ID bound, display fields to short text, description/summary to at most 1,024, and capabilities to unique lists of at most 32. Require valid creation/update Timestamps and reject unspecified enum values where required.

- [ ] **Step 3: Declare the neutral ProviderService method inventory**

```proto
service ProviderService {
  rpc ListProviderTypes(ListProviderTypesRequest) returns (ListProviderTypesResponse);
  rpc ListProviderInstances(ListProviderInstancesRequest) returns (ListProviderInstancesResponse);
  rpc GetProviderInstance(GetProviderInstanceRequest) returns (GetProviderInstanceResponse);
  rpc TestProviderConfiguration(TestProviderConfigurationRequest) returns (TestProviderConfigurationResponse);
  rpc CreateProviderInstance(CreateProviderInstanceRequest) returns (CreateProviderInstanceResponse);
  rpc UpdateProviderInstance(UpdateProviderInstanceRequest) returns (UpdateProviderInstanceResponse);
  rpc TestProviderInstance(TestProviderInstanceRequest) returns (TestProviderInstanceResponse);
  rpc DeleteProviderInstance(DeleteProviderInstanceRequest) returns (DeleteProviderInstanceResponse);
}
```

- [ ] **Step 4: Add provider list and get messages**

| Message | Fields in tag order |
| --- | --- |
| `ListProviderTypesRequest` | `page_size`, `page_token` |
| `ListProviderTypesResponse` | repeated `provider_types`, `next_page_token` |
| `ListProviderInstancesRequest` | `page_size`, `page_token` |
| `ListProviderInstancesResponse` | repeated `provider_instances`, `next_page_token` |
| `GetProviderInstanceRequest` | `provider_instance_id` |
| `GetProviderInstanceResponse` | required `provider_instance` |

Cap list results and non-zero page sizes at 100.

- [ ] **Step 5: Add candidate and stored-configuration test messages**

| Message | Fields in tag order |
| --- | --- |
| `TestProviderConfigurationRequest` | `provider_type_id`, required `configuration` |
| `TestProviderConfigurationResponse` | required `result` |
| `TestProviderInstanceRequest` | `provider_instance_id` |
| `TestProviderInstanceResponse` | required `result` |

Provider-schema validation and remote connection outcomes follow the approved handler semantics; the Protobuf schema enforces only IDs, presence, and Struct bounds.

- [ ] **Step 6: Add create and update messages**

| Message | Fields in tag order |
| --- | --- |
| `CreateProviderInstanceRequest` | `operation_id`, `provider_type_id`, `display_name`, required `configuration`, `enabled`, optional `sync_priority` |
| `CreateProviderInstanceResponse` | required `provider_instance` |
| `UpdateProviderInstanceRequest` | `operation_id`, `provider_instance_id`, `expected_revision`, optional `display_name`, optional `enabled`, optional `sync_priority`, required `configuration_patch`, repeated `clear_configuration_fields` |
| `UpdateProviderInstanceResponse` | required `provider_instance` |

Use lower-snake-case validation for `clear_configuration_fields`; make it unique and at most 100 entries. Patch/clear overlap, required-key removal, revision checks, instance limit, and immutable remote user remain handler rules.

- [ ] **Step 7: Add delete messages**

| Message | Fields in tag order |
| --- | --- |
| `DeleteProviderInstanceRequest` | `operation_id`, `provider_instance_id`, `expected_revision` |
| `DeleteProviderInstanceResponse` | no fields |

Delete-busy and state ownership remain handler semantics; do not add state-dependent CEL.

- [ ] **Step 8: Generate the provider-management clients**

Run: `mise run generate`

- [ ] **Step 9: Prove there is no provider-branded public symbol**

Run:

```bash
if rg -n -i '\b(jellyfin|plex)\b' proto/nama/api; then
  printf '%s\n' 'unexpected provider brand in public contract' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
```

Expected: no matches.

- [ ] **Step 10: Run the provider-management schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 11: Commit provider management**

```bash
git add proto/nama/api/v1/provider.proto gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add provider management contract"
```

### Task 5: Add stable synchronization status and run contracts

**Files:**

- Create: `proto/nama/api/v1/sync.proto`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: opaque provider-instance IDs and Timestamp.
- Produces: stable CLI-readable status plus provider and aggregate run models with explicit child references.

- [ ] **Step 1: Declare sync enums exactly**

```proto
enum SyncStatus {
  SYNC_STATUS_UNSPECIFIED = 0;
  SYNC_STATUS_IDLE = 1;
  SYNC_STATUS_QUEUED = 2;
  SYNC_STATUS_RUNNING = 3;
  SYNC_STATUS_FAILED = 4;
  SYNC_STATUS_DISABLED = 5;
}

enum SyncPhase {
  SYNC_PHASE_UNSPECIFIED = 0;
  SYNC_PHASE_QUEUED = 1;
  SYNC_PHASE_RUNNING = 2;
  SYNC_PHASE_PULLING = 3;
  SYNC_PHASE_RECONCILING = 4;
  SYNC_PHASE_PUSHING = 5;
  SYNC_PHASE_COMPLETED = 6;
  SYNC_PHASE_FAILED = 7;
}
```

- [ ] **Step 2: Declare run and status resources**

| Message | Fields in tag order |
| --- | --- |
| `SyncCounts` | `items_scanned`, `canonical_states_reconciled`, `mutations_attempted`, `mutations_applied`, `mutations_failed` as `uint64` |
| `SyncChildRunReference` | `sync_run_id`, `provider_instance_id` |
| `SyncRun` | `id`, optional `provider_instance_id`, `phase`, required `created_at`, optional `started_at`, optional `finished_at`, required `counts`, optional `failure_summary`, repeated `child_runs` |
| `ProviderSyncStatus` | `provider_instance_id`, `status`, optional `active_run`, optional `last_success_at`, optional `next_attempt_at`, optional `failure_summary` |

Bound child references to 100 and failure summaries to 1,024; require every present run Timestamp to be valid. An aggregate parent's `created_at` is trigger time; `started_at` is that time when any joined child is already active, otherwise the first later child start; and `finished_at` follows every referenced child reaching a terminal phase. Joined-child counts cover each referenced child's full lifetime, including work before the parent joined it. These phase, timestamp, count, and aggregate-precedence rules are handler semantics rather than duplicated CEL.

- [ ] **Step 3: Declare the three RPCs and exact response names**

```proto
service SyncService {
  rpc GetSyncStatus(GetSyncStatusRequest) returns (GetSyncStatusResponse);
  rpc TriggerSync(TriggerSyncRequest) returns (TriggerSyncResponse);
  rpc GetSyncRun(GetSyncRunRequest) returns (GetSyncRunResponse);
}
```

| Message | Fields in tag order |
| --- | --- |
| `GetSyncStatusRequest` | optional `provider_instance_id`, `page_size`, `page_token` |
| `GetSyncStatusResponse` | `aggregate_status`, repeated `provider_statuses`, `next_page_token` |
| `TriggerSyncRequest` | `operation_id`, optional `provider_instance_id` |
| `TriggerSyncResponse` | required `run` |
| `GetSyncRunRequest` | `sync_run_id` |
| `GetSyncRunResponse` | required `run` |

Do not add separate pull, push, cancel, or provider-specific sync methods.

- [ ] **Step 4: Generate the synchronization contracts**

Run: `mise run generate`

- [ ] **Step 5: Run the synchronization schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 6: Commit the synchronization contracts**

```bash
git add proto/nama/api/v1/sync.proto gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add synchronization contracts"
```

### Task 6: Lock the management authorization inventory

**Files:**

- Modify: `.oxlintrc.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/server/package.json`
- Modify: `apps/server/tsconfig.json`
- Create: `apps/server/src/contract-authorization.ts`
- Create: `apps/server/src/contract.test.ts`
- Modify: `apps/server/src/contract-probe.ts`

**Interfaces:**

- Consumes: generated service descriptors from Tasks 1–5.
- Produces: a descriptor-keyed, default-deny inventory covering every management method exactly once; later runtime code can consume the same table rather than recreating it.

- [ ] **Step 1: Add the first handwritten contract-test infrastructure**

Add exact `@types/node@24.13.3` and `@bufbuild/protobuf@2.13.0` server dev dependencies. Add `"check:contract": "node --test src/contract.test.ts"` to `apps/server/package.json`, set the root `check:ts` script to `pnpm run check:format && pnpm run check:lint && pnpm run check:type && pnpm --filter @nama/server run check:contract`, and add `"types": ["node"]` to the server compiler options. Restore only these lint allowances:

```json
"import/no-nodejs-modules": ["error", { "allow": ["node:assert/strict", "node:test"] }],
"eslint/no-duplicate-imports": ["error", { "allowSeparateTypeImports": true }],
"eslint/sort-imports": ["warn", { "allowSeparatedGroups": true }]
```

Do not add another test runner or generalized lint exceptions.

- [ ] **Step 2: Add an intentionally incomplete method inventory**

Represent authority as string literals, not a framework:

```ts
export type ContractAuthority =
  | "public"
  | "bootstrap-token"
  | "polling-token"
  | "administrator"
  | "administrator-or-device";

export const contractAuthorityByMethod = {
  "nama.api.v1.SetupService.GetStatus": "public",
} as const satisfies Record<string, ContractAuthority>;
```

Add a test that uses the generated service method descriptors as inputs, collects their fully qualified method names, and compares that sorted set with the handwritten map keys. Do not assert generated descriptor presence, names, or counts independently.

- [ ] **Step 3: Run the authorization-inventory red check**

Run: `pnpm --filter @nama/server run check:contract`

Expected: FAIL and list the missing methods.

- [ ] **Step 4: Complete the management inventory**

Assign:

- `SetupService.GetStatus` → `public`;
- `SetupService.CreateAdministrator` → `bootstrap-token`;
- `AuthService.SignIn` and `DeviceService.BeginPairing` → `public`;
- `DeviceService.GetPairingStatus` → `polling-token`;
- both Health methods, `AuthService.GetCurrentUser`, `AuthService.SignOut`, device approval/list/revoke, all Provider methods, and all Sync methods → `administrator`.

No generated method may be absent or listed twice. The public media plan adds the consumer methods to this same table. This assertion tests the handwritten default-deny policy, not generated descriptor construction or method presence.

- [ ] **Step 5: Expand only the server compile probe**

Reference each management service descriptor and both public/plugin common namespaces from the existing TypeScript server probe. Keep the CLI and tvOS application entry points on their approved Health-only Milestone 0 probes. No Go or Swift contract test exists; those applications accept generated code through their real compile probes.

- [ ] **Step 6: Run the plan-level checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS and the handwritten authorization inventory has exactly the same method keys as the generated management descriptors.

- [ ] **Step 7: Commit the management contract inventory**

```bash
git add .oxlintrc.json package.json pnpm-lock.yaml apps/server/package.json apps/server/tsconfig.json apps/server/src/contract-authorization.ts apps/server/src/contract.test.ts apps/server/src/contract-probe.ts
git commit -m "test(api): lock management method inventory"
```

## Plan 2 Completion Gate

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
if rg -n -i '\b(jellyfin|plex)\b' proto/nama/api; then
  printf '%s\n' 'unexpected provider brand in public contract' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
git status --short
```

Expected: all checks pass; the provider-brand search returns no matches; only intentional work for plans 3–4 remains uncommitted.
