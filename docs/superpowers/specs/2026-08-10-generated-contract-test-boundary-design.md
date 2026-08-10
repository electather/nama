# Generated Contract Test Boundary Design

## Decision

Nama will not test code generated from Protobuf or Connect schemas. Buf, the language generators, and their serialization runtimes own that behavior. Milestone 0 will instead verify the schemas, deterministic generated output, and consumption of that output by real applications.

A test belongs on the retained side of this boundary when its subject is handwritten Nama behavior. Using a generated message, descriptor, or error detail as an input does not make such a test a generated-code test.

## Remove

Delete tests in TypeScript, Go, and Swift whose only assertion is that generated bindings behave as generated. This includes:

- binary or JSON serialization round trips;
- generated message, field, enum, package, service, or method presence;
- unknown enum, unknown field, or unknown oneof preservation;
- parity between public and plugin generated packages or between generated languages; and
- construction or round trips of generated Google RPC error details without handwritten Nama behavior.

Delete test files or suites containing only those checks. Also remove support used solely by them:

- dedicated test commands and CI steps;
- test-only dependencies and their lockfile entries;
- the generated Swift package test target, `gen/swift/Tests`, and `gen/swift/Package.resolved`;
- formatting, linting, or task inputs that mention deleted test paths; and
- plan steps and documentation claims that require generated-binding tests.

Generic language checks remain when they also compile applications or run present and future handwritten tests. Runtime and package dependencies required to compile generated clients remain.

## Retain

The contract gate continues to run:

- Buf format, lint, and module build;
- Buf breaking-change checks against the pull-request base;
- deterministic regeneration and direct drift comparison for every committed generated leaf; and
- TypeScript, Go, and tvOS application compile probes that consume generated clients.

Tests of handwritten Nama policy and logic remain. The approved Milestone 0 examples are:

- completeness and default-deny behavior of the authorization inventory;
- the custom CEL validation rule;
- deterministic per-field error normalization; and
- adapters that translate between generated transport values and Nama-owned behavior.

These tests may inspect generated descriptors or use generated values as fixtures when doing so exercises the handwritten behavior named by the test.

## Documentation Reconciliation

Implementation must reconcile the boundary everywhere it is normative:

- `docs/architecture/api-contracts.md` and any repository, release, CLI, server, or tvOS architecture text that promises generated-binding tests;
- all four Milestone 0 implementation plans under `docs/superpowers/plans/`;
- package manifests, task definitions, CI workflow steps, and lockfiles that support the removed tests; and
- task acceptance criteria that currently use round trips or generated descriptor assertions as proof.

Rewritten plan steps must use the retained Buf gates and real application compile probes for generated-contract acceptance. Handwritten policy and adapter steps keep focused behavioral tests.

## Verification

The change is complete when:

1. no tracked TypeScript, Go, or Swift test has generated bindings as its subject;
2. no command, dependency, Swift target, lockfile, CI step, or documentation requirement exists solely for those deleted tests;
3. Buf format, lint, build, breaking-change, and deterministic drift checks remain configured;
4. the real TypeScript, Go, and tvOS application compile probes remain configured and pass in their supported environments;
5. retained handwritten policy and adapter tests pass; and
6. generated leaves are changed only through the existing deterministic generation workflow, never by hand.

## Non-goals

- Replacing deleted tests with new generated-code smoke tests, snapshots, fixtures, or conformance harnesses.
- Testing Protobuf, Connect, Buf, generator, or language-runtime behavior in Nama.
- Removing generated clients, schema validation, drift detection, breaking-change detection, or application compile coverage.
- Removing a dependency that generated clients or handwritten code require.
- Changing any RPC, message, field, validation rule, authorization policy, adapter behavior, or runtime implementation.
