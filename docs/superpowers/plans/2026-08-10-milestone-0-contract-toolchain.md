# Milestone 0 Contract Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the deterministic dependency, generation, validation, and native round-trip test foundation required by the complete Milestone 0 contracts.

**Architecture:** Buf remains the only schema and generation owner. The local module imports pinned Protovalidate and Google API schemas; TypeScript generates both Nama packages, Go generates public Nama only, and Swift generates public Nama plus selected dependency-owned Google RPC details and required imported support. Handwritten manifests and tests stay outside Buf-cleaned leaves.

**Tech Stack:** Buf 1.72.0, Protobuf, Protovalidate v1 annotations, protoc-gen-es 2.13.0, protoc-gen-go 1.36.11, Connect-Go 1.20.0, SwiftProtobuf 1.38.1, Connect-Swift 1.2.3, Node.js 24, Go 1.26, Swift 6/Xcode 26.6, mise.

## Global Constraints

- This is plan 1 of 4. Execute it before the public-management, public-media/playback, and plugin-contract plans.
- Before changing schemas, run `git status --short`, confirm the approved contract and plan documents are committed on the implementation branch, and stop on unrelated changes. Do not make implementation commits on top of an ambiguous documentation worktree.
- Execute all four plans on one feature branch/worktree and merge only after the Milestone 0 completion gate. Task commits are review checkpoints, not partial v1 releases.
- Milestone 0 creates schemas, generated SDKs, compile probes, and descriptor/round-trip checks only. It creates no handlers, database tables, provider clients, fake servers, or runtime behavior.
- `nama.api.v1` and `nama.plugin.v1` never import each other or a third Nama package.
- Every enum starts with an `*_UNSPECIFIED = 0` value. Every RPC is unary and has method-specific request and response messages; do not use `google.protobuf.Empty`.
- Required enum fields exclude only zero with `(buf.validate.field).enum = { not_in: [0] }`. Never use `defined_only`: unknown future numeric enum values must remain valid for forward-compatible clients.
- Preserve `ServingStatus` values 0, 1, and 2, `CheckResponse.status = 1`, and `HealthService.Check` exactly.
- Generated-only leaves are `gen/ts/src`, `gen/go`, and `gen/swift/Sources/NamaAPI`. Never place manifests or handwritten tests inside them and never hand-edit generated code.
- Generated TypeScript contains both public and plugin packages. Generated Go and Swift exclude `nama.plugin.v1`; Swift additionally contains selected `google.rpc` details and required imported support.
- Use `optional` only when absence differs from a present zero value. Use Protovalidate for structural constraints; leave state-dependent validation to later handlers.
- Annotate every present `google.protobuf.Timestamp` with `(buf.validate.field).timestamp = {}`. Annotate every present `google.protobuf.Duration` with a duration rule; later plans add the exact non-negative, positive, or bounded range.
- Use these uniform structural bounds unless a contract method has a smaller explicit limit: opaque IDs/revisions 1–256 UTF-8 characters, secrets/tokens 1–4096, short human text 1–256, long human text at most 16,384, URLs/header values at most 8,192, headers at most 32, redirect origins at most 16, and ordinary repeated collections at most 100.
- A page size of zero means the documented default; non-zero values are at most 100. Do not encode a default page size into the wire schema.
- Dependency additions are driven by generated imports. Do not add validation runtimes to a language whose generated or handwritten code does not use them.

---

### Task 1: Pin external schema dependencies

**Files:**

- Modify: `buf.yaml`
- Create: `buf.lock`
- Create: `proto/nama/api/v1/common.proto`
- Create: `proto/nama/plugin/v1/common.proto`

**Interfaces:**

- Consumes: the existing Buf v2 module rooted at `proto/`.
- Produces: public `HttpHeader` and `BearerCredential`; private `HttpHeader` and hierarchical provider references used by every later plan.

- [ ] **Step 1: Add the two package-local common schemas before declaring their imports**

Create the public common schema with fields in this exact order, so the listed order fixes tags 1 and 2:

```proto
syntax = "proto3";

package nama.api.v1;

import "buf/validate/validate.proto";
import "google/protobuf/timestamp.proto";

message HttpHeader {
  string name = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
  string value = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 8192
  ];
}

message BearerCredential {
  string token = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 4096
  ];
  google.protobuf.Timestamp expires_at = 2 [
    (buf.validate.field).required = true,
    (buf.validate.field).timestamp = {}
  ];
}
```

Create the private common schema with a separate `HttpHeader` plus these reference messages. Each nested reference is required, and every string uses the 1–256 opaque-ID rule:

```proto
syntax = "proto3";

package nama.plugin.v1;

import "buf/validate/validate.proto";

message HttpHeader {
  string name = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
  string value = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 8192
  ];
}

message ProviderItemReference {
  string item_id = 1 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
}
message ProviderSourceReference {
  ProviderItemReference item_reference = 1 [(buf.validate.field).required = true];
  string source_id = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
}
message ProviderPartReference {
  ProviderSourceReference source_reference = 1 [(buf.validate.field).required = true];
  string part_id = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
}
message ProviderTrackReference {
  ProviderPartReference part_reference = 1 [(buf.validate.field).required = true];
  string track_id = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
}
message ProviderArtworkReference {
  ProviderItemReference item_reference = 1 [(buf.validate.field).required = true];
  string artwork_id = 2 [
    (buf.validate.field).string.min_len = 1,
    (buf.validate.field).string.max_len = 256
  ];
}
```

- [ ] **Step 2: Run the narrow check and observe the missing-module failure**

Run: `buf lint`

Expected: FAIL because `buf/validate/validate.proto` is not yet available to the module.

- [ ] **Step 3: Declare and lock the schema dependencies**

Add this top-level block to `buf.yaml` without changing the existing module, lint, or breaking configuration:

```yaml
deps:
  - buf.build/bufbuild/protovalidate:435963d1631043e694e56e6bcc3c79c3
  - buf.build/googleapis/googleapis:c17df5b2beca46928cc87d5656bd5343
```

Run: `buf dep update`

Expected: `buf.lock` is created with immutable commits and digests for both dependencies. Do not edit the lock by hand.

- [ ] **Step 4: Format and validate the common schemas**

Run:

```bash
buf format -w proto
buf lint
buf build
```

Expected: PASS.

- [ ] **Step 5: Commit the dependency and common-schema slice**

```bash
git add buf.yaml buf.lock proto/nama/api/v1/common.proto proto/nama/plugin/v1/common.proto
git commit -m "feat(api): add contract foundations"
```

### Task 2: Generate selected dependency-owned types

**Files:**

- Modify: `buf.gen.yaml`
- Create: `buf.gen.googleapis.yaml`
- Modify: `mise.toml`
- Modify: `gen/ts/package.json`
- Modify: `pnpm-lock.yaml`
- Modify if generated imports require it: `go.mod`
- Modify if generated imports require it: `go.sum`
- Regenerate: `gen/ts/src/**`
- Regenerate: `gen/go/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: the exact googleapis and Protovalidate commits recorded in `buf.lock`.
- Produces: local/common generated code plus `google.rpc.ErrorInfo`, `BadRequest`, `RequestInfo`, and `RetryInfo` for clients to unpack from Connect errors.

- [ ] **Step 1: Confirm the resolved googleapis commit**

Run: `rg -A3 'name: buf.build/googleapis/googleapis' buf.lock`

Expected: immutable commit `c17df5b2beca46928cc87d5656bd5343`, matching `buf.yaml`. If it differs, stop: the checked-in dependency pin and the generation input must be changed together in a deliberate dependency update.

- [ ] **Step 2: Split local and selected-googleapis generation**

Buf 1.72 evaluates plugin filters independently against every configured input. Keep `buf.gen.yaml` as the cleaning local-module template with one explicit input:

```yaml
inputs:
  - directory: proto
```

Configure the local ES plugin and both local Swift plugins with `include_imports: true`. Keep `nama.plugin.v1` excluded from Go and Swift. Keep the existing Nama Go package-prefix override and the Protovalidate managed-mode disable; no googleapis input or `google.rpc` exclusion belongs in this local template.

Create `buf.gen.googleapis.yaml` as a non-cleaning second template:

```yaml
version: v2
clean: false
inputs:
  - module: buf.build/googleapis/googleapis:c17df5b2beca46928cc87d5656bd5343
    types:
      - google.rpc.ErrorInfo
      - google.rpc.BadRequest
      - google.rpc.RequestInfo
      - google.rpc.RetryInfo
plugins:
  - remote: buf.build/bufbuild/es:v2.13.0
    revision: 1
    out: gen/ts/src
    include_imports: true
    opt:
      - target=js+dts
      - import_extension=js
  - remote: buf.build/apple/swift:v1.38.1
    revision: 1
    out: gen/swift/Sources/NamaAPI
    include_imports: true
    opt:
      - Visibility=Public
      - FileNaming=PathToUnderscores
```

Do not add Go or Connect-Swift plugins to the selected-googleapis template: Go consumes dependency-owned error details from `google.golang.org/genproto`, and the selected messages define no services. Keep WKT generation disabled.

Keep this managed-mode disable in the local template so it never rewrites dependency-owned Protovalidate `go_package` options:

```yaml
disable:
  - file_option: go_package_prefix
    module: buf.build/bufbuild/protovalidate
```

Change `mise` generation ownership to run the cleaning local template first and the additive selected-googleapis template second:

```toml
[tasks.generate]
description = "Generate committed clients from Protobuf schemas"
run = [
  "buf generate --template buf.gen.yaml",
  "buf generate --template buf.gen.googleapis.yaml",
]
```

Change the existing `check:contracts` generation line from `buf generate` to `mise run generate`; Task 4 later hardens the rest of that gate.

- [ ] **Step 3: Simplify generated TypeScript exports**

Replace the two-file export list in `gen/ts/package.json` with one native subpath pattern that exposes generated JavaScript at runtime and declarations to TypeScript:

```json
"exports": {
  "./*.js": {
    "types": "./src/*.d.ts",
    "default": "./src/*.js"
  }
}
```

Use `target=js+dts` on the ES plugin in both generation templates. Generated relative `.js` imports then resolve to committed sibling JavaScript while the `.d.ts` files preserve the TypeScript SDK surface. Keep `@bufbuild/protobuf` exact-pinned. Do not add `@bufbuild/protovalidate` to `@nama/api`: the generated SDK imports only Protobuf and local generated files. Plan 4 Task 5 adds it directly to the server when the validation harness first imports it.

- [ ] **Step 4: Generate every configured client**

Run: `mise run generate`

Expected: ES generates executable JavaScript plus declarations for both Nama packages, transitive validation/date support, and selected error-detail types; Go excludes the plugin package, and Swift excludes it while generating selected Google RPC details and required imported support.

- [ ] **Step 5: Let native manifests follow actual imports**

Run:

```bash
pnpm install
go mod tidy
```

Review generated imports before retaining any new runtime dependency. `go mod tidy` is authoritative for Go module additions.

- [ ] **Step 6: Verify generated package boundaries**

Run:

```bash
if rg -n 'nama/plugin/v1' gen/go gen/swift; then
  printf '%s\n' 'unexpected private contract in a public generated client' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
rg --files gen/ts/src/google/rpc | sort
```

Expected: the first command has no matches; the second lists exactly the files needed for `ErrorInfo`, `BadRequest`, `RequestInfo`, and `RetryInfo` plus generator-required support files, not the entire googleapis module.

- [ ] **Step 7: Commit deterministic generation ownership**

```bash
git add buf.gen.yaml buf.gen.googleapis.yaml mise.toml gen/ts/package.json pnpm-lock.yaml go.mod go.sum gen/ts gen/go gen/swift/Sources/NamaAPI docs/superpowers/plans/2026-08-10-milestone-0-contract-toolchain.md
git commit -m "build(api): pin contract generation inputs"
```

### Task 3: Add one native round-trip harness per generated consumer

**Files:**

- Modify: `apps/server/package.json`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/server/src/contract.test.ts`
- Create: `apps/cli/internal/cli/contracts_test.go`
- Modify: `gen/swift/Package.swift`
- Create: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Create after SwiftPM resolution: `gen/swift/Package.resolved`
- Modify: `mise.toml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: generated common schemas, standard Google error details, and direct Node/Protobuf test dependencies.
- Produces: one expandable TypeScript baseline test for both packages, one Go public test, and one Swift public test. Plan 4 Task 5 adds the direct validation runtime when the harness first validates generated schemas.

- [ ] **Step 1: Create the complete TypeScript baseline fixture**

Use Node's built-in test runner and Protobuf-ES `create`, `toBinary`, and `fromBinary` APIs. The test must construct both package-local `HttpHeader` values and a public `BearerCredential`, then assert deep equality after binary round trip. Also construct each selected `google.rpc` detail once so missing generated inputs fail compilation.

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  create,
  fromBinary,
  toBinary,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  BadRequestSchema,
  ErrorInfoSchema,
  RequestInfoSchema,
  RetryInfoSchema,
} from "@nama/api/google/rpc/error_details_pb.js";
import {
  BearerCredentialSchema,
  HttpHeaderSchema as PublicHttpHeaderSchema,
} from "@nama/api/nama/api/v1/common_pb.js";
import { HttpHeaderSchema as PluginHttpHeaderSchema } from "@nama/api/nama/plugin/v1/common_pb.js";

function assertRoundTrip<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
): void {
  assert.deepEqual(fromBinary(schema, toBinary(schema, message)), message);
}

test("common messages round-trip across both Nama packages", () => {
  const publicHeader = create(PublicHttpHeaderSchema, { name: "x-test", value: "public" });
  const pluginHeader = create(PluginHttpHeaderSchema, { name: "x-test", value: "plugin" });
  const credential = create(BearerCredentialSchema, {
    token: "opaque",
    expiresAt: { seconds: 1n, nanos: 0 },
  });
  assertRoundTrip(PublicHttpHeaderSchema, publicHeader);
  assertRoundTrip(PluginHttpHeaderSchema, pluginHeader);
  assertRoundTrip(BearerCredentialSchema, credential);
});

test("selected google.rpc details compile and round-trip", () => {
  assertRoundTrip(ErrorInfoSchema, create(ErrorInfoSchema, { reason: "TEST", domain: "nama.api.v1" }));
  assertRoundTrip(
    BadRequestSchema,
    create(BadRequestSchema, {
      fieldViolations: [{ field: "field", description: "invalid", reason: "REQUIRED" }],
    }),
  );
  assertRoundTrip(RequestInfoSchema, create(RequestInfoSchema, { requestId: "request-1" }));
  assertRoundTrip(
    RetryInfoSchema,
    create(RetryInfoSchema, { retryDelay: { seconds: 1n, nanos: 0 } }),
  );
});
```

- [ ] **Step 2: Run the TypeScript red check**

Run: `pnpm --filter @nama/server run check:type`

Expected: FAIL because the server package does not yet own the Node or Protobuf dependencies used by its contract harness.

- [ ] **Step 3: Add the two direct server test dependencies**

Run: `pnpm --filter @nama/server add --save-dev --save-exact @types/node@24.13.3 @bufbuild/protobuf@2.13.0`

pnpm's strict package boundary must not rely on `@nama/api` exposing its runtime dependencies. Plan 4 Task 5 adds the direct Protovalidate dependency when it first imports `createValidator`.

- [ ] **Step 4: Add the server contract-test script**

Add `"check:contract": "node --experimental-transform-types --test src/contract.test.ts"` to `apps/server/package.json`. Generated Protobuf-ES files contain TypeScript enums that Node 24's default strip-only loader cannot execute; do not add a separate TypeScript runner.

- [ ] **Step 5: Wire the contract script into the root TypeScript check**

Run the server's `check:contract` after root type checking in `package.json`, preserving the existing format/lint/type order.

- [ ] **Step 6: Format the TypeScript contract baseline**

Run: `pnpm exec oxfmt apps/server/src/contract.test.ts`

- [ ] **Step 7: Run the first TypeScript contract baseline**

Run: `pnpm --filter @nama/server run check:contract`

Expected: PASS. A missing generated import, export, or runtime fails here before the schema surface expands in later plans.

- [ ] **Step 8: Add the Go common/error-detail round trip**

Create `apps/cli/internal/cli/contracts_test.go` with this complete baseline; do not compare generated implementation fields:

```go
package cli

import (
	"testing"
	"time"

	apiv1 "github.com/electather/nama/gen/go/nama/api/v1"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestContractRoundTrips(t *testing.T) {
	fixtures := []proto.Message{
		&apiv1.HttpHeader{Name: "x-test", Value: "public"},
		&apiv1.BearerCredential{Token: "opaque", ExpiresAt: timestamppb.New(time.Unix(1, 0))},
		&errdetails.ErrorInfo{Reason: "TEST", Domain: "nama.api.v1"},
		&errdetails.BadRequest{FieldViolations: []*errdetails.BadRequest_FieldViolation{{
			Field: "field", Description: "invalid", Reason: "REQUIRED",
		}}},
		&errdetails.RequestInfo{RequestId: "request-1"},
		&errdetails.RetryInfo{RetryDelay: durationpb.New(time.Second)},
	}

	for _, want := range fixtures {
		encoded, err := proto.Marshal(want)
		if err != nil {
			t.Fatal(err)
		}
		got := want.ProtoReflect().Type().New().Interface()
		if err := proto.Unmarshal(encoded, got); err != nil {
			t.Fatal(err)
		}
		if !proto.Equal(got, want) {
			t.Fatalf("round trip mismatch for %s", want.ProtoReflect().Descriptor().FullName())
		}
	}
}
```

- [ ] **Step 9: Run the Go contract fixture**

Run: `go test ./apps/cli/internal/cli -run TestContractRoundTrips -count=1`

Expected: PASS.

- [ ] **Step 10: Add the Swift package test target**

Add this target beside the existing library target in `gen/swift/Package.swift`:

```swift
.testTarget(
  name: "NamaAPITests",
  dependencies: [
    "NamaAPI",
    .product(name: "SwiftProtobuf", package: "swift-protobuf"),
  ]
)
```

- [ ] **Step 11: Add the Swift public round-trip fixture**

Create `gen/swift/Tests/NamaAPITests/ContractTests.swift` with the public header round trip and exact selected-type compile proof:

```swift
import NamaAPI
import SwiftProtobuf
import XCTest

final class ContractTests: XCTestCase {
  func testCommonContractRoundTrip() throws {
    var header = Nama_Api_V1_HttpHeader()
    header.name = "x-test"
    header.value = "public"

    let encoded = try header.serializedData()
    let decoded = try Nama_Api_V1_HttpHeader(serializedBytes: encoded)
    XCTAssertEqual(decoded, header)

    _ = Google_Rpc_ErrorInfo()
    _ = Google_Rpc_BadRequest()
    _ = Google_Rpc_RequestInfo()
    _ = Google_Rpc_RetryInfo()
  }
}
```

- [ ] **Step 12: Run the Swift contract fixture**

Run: `swift test --package-path gen/swift`

Expected: PASS and a SwiftPM `Package.resolved` containing the exact dependencies already declared by the package.

- [ ] **Step 13: Make the local Go owner check compare before and after**

In `check:go`, capture `lock_state="$(cksum go.mod go.sum)"` before `go vet`/`go test`, then finish with `test "$lock_state" = "$(cksum go.mod go.sum)"`. This permits an intentional pre-existing module edit while detecting mutation caused by the check.

- [ ] **Step 14: Add the Swift package test to local format and check tasks**

Include `gen/swift/Tests` in the Swift format and strict-format-lint path lists. In `check:swift`, capture one `cksum` snapshot of both resolved files, run `swift test --package-path gen/swift` before the tvOS build, then compare the same two files with the snapshot. Do not add a root test framework or universal test command.

- [ ] **Step 15: Extend setup for the generated Swift package lock**

Run `swift package resolve --package-path gen/swift` from `setup`, then include `gen/swift/Package.resolved` in its clean-checkout `git diff --exit-code` lock check. Setup keeps comparing to `HEAD` because it is defined to start from committed lock state.

- [ ] **Step 16: Extend the existing macOS CI job**

After package resolution, run `swift test --package-path gen/swift`, include `gen/swift/Tests` in strict formatting, and include both resolved files in the clean-checkout lock checks before and after tests/build. Do not add another job.

- [ ] **Step 17: Format the native contract fixtures**

Run: `mise run format`

- [ ] **Step 18: Run all three narrow checks**

Run:

```bash
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 19: Commit the native contract harnesses**

```bash
git add package.json apps/server/package.json apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Package.swift gen/swift/Package.resolved gen/swift/Tests mise.toml .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "test(api): add native contract round trips"
```

### Task 4: Make contract drift checks complete

**Files:**

- Modify: `mise.toml`
- Verify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: the existing `check:contracts` task and PR-only `buf-breaking` CI job.
- Produces: one local contract gate covering format, lint, module build, and deterministic generation without rejecting an intentional already-regenerated working-tree change.

- [ ] **Step 1: Demonstrate that formatting is currently outside the contract check**

Make a whitespace-only change in a temporary copy of one schema and run the current commands individually. Confirm `buf lint` alone does not replace a format gate; discard only the temporary copy.

- [ ] **Step 2: Harden `check:contracts` without adding another wrapper**

The task body must run, in order:

```bash
set -eu
buf format --diff --exit-code
buf lint
buf build
snapshot_dir="$(mktemp -d "${TMPDIR:-/tmp}/nama-contracts.XXXXXX")"
test -n "$snapshot_dir"
test -d "$snapshot_dir"
test ! -L "$snapshot_dir"
trap 'rm -rf -- "${snapshot_dir:?}"' EXIT
mkdir -p "$snapshot_dir/gen/ts" "$snapshot_dir/gen/swift/Sources"
cp -R gen/ts/src "$snapshot_dir/gen/ts/src"
cp -R gen/go "$snapshot_dir/gen/go"
cp -R gen/swift/Sources/NamaAPI "$snapshot_dir/gen/swift/Sources/NamaAPI"
mise run generate
diff -ru "$snapshot_dir/gen/ts/src" gen/ts/src
diff -ru "$snapshot_dir/gen/go" gen/go
diff -ru "$snapshot_dir/gen/swift/Sources/NamaAPI" gen/swift/Sources/NamaAPI
```

The before/after comparisons cover only Buf-owned leaves, so local `node_modules`, Swift `.build`, manifests, locks, and handwritten tests are never copied. They detect changed, added, and removed generated files and pass when an implementation task has already regenerated an intentional uncommitted schema change, while CI still fails when checked-in output is stale. The validated `mktemp` directory is the only recursive cleanup target.

- [ ] **Step 3: Confirm CI ownership remains thin**

Verify `.github/workflows/ci.yml` still calls `mise run check:contracts` and retains the full-history, pull-request-base `buf breaking` job. Make no workflow change unless the local task name changed.

- [ ] **Step 4: Run the toolchain gate twice**

Run `mise run check:contracts` twice as two separate commands.

Expected: both runs PASS and the second run produces no generated diff.

- [ ] **Step 5: Commit the completed toolchain gate**

```bash
git add mise.toml .github/workflows/ci.yml
git commit -m "build(api): verify deterministic contracts"
```

## Plan 1 Completion Gate

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
git status --short
```

Expected: every check passes; only intentionally uncommitted work from later plans is listed. Do not start plan 2 while generated dependency ownership is unresolved in any language.
