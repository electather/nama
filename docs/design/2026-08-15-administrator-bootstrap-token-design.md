# Administrator Bootstrap Token Design

Status: approved in chat; pending written review.
Issue: #22.

## Outcome

A setup-eligible server emits one high-entropy administrator bootstrap token after binding its listener. The process retains only a digest. The token authorizes at most one successful or possibly committed administrator creation. Restart replaces every unused token. Durable initialization permanently prevents later token generation.

## Scope

Issue #22 owns:

- startup eligibility handoff from database reconciliation;
- in-memory bootstrap-token generation and state;
- the one raw operator-console output exception;
- constant-time candidate validation;
- exclusive attempt and terminal-disable semantics;
- focused and real-process verification; and
- reconciliation of architecture documentation with the implemented boundary.

Issue #22 does not add:

- Connect handlers or routes;
- Better Auth runtime integration;
- administrator creation or marker mutation;
- public error mapping;
- Protobuf or generated binding changes;
- database schema or migration changes;
- CLI behavior;
- configuration fields;
- dependencies; or
- structured-log fields.

Issue #23 will use this capability inside `SetupService.CreateAdministrator`.

## Existing constraints

- Database reconciliation is the only startup authority for `configured` versus `setup-eligible`.
- Setup never reopens after durable initialization or integrity failure.
- The listener binds only after configuration, migrations, reconciliation, and the initial database probe succeed.
- The token is never persisted.
- The bootstrap line is the only deliberate secret-output exception.
- Better Auth remains private and absent in issue #22.
- One process serves one private deployment and one administrator.

## Architecture

| Unit | Responsibility | Dependencies |
| --- | --- | --- |
| Database | Reconcile durable initialization and expose its immutable startup classification. | Configuration and PostgreSQL. |
| Bootstrap token | Own cryptography, raw output, digest, validation, attempt state, and disable semantics. | Database startup classification. |
| Application composition | Acquire the listener, activate bootstrap output, then announce readiness. | Configuration, logging, database, setup, and HTTP. |
| HTTP | Preserve exact health routing and listener lifecycle. | Configuration and database. |

Add `apps/server/src/setup/` as a Fallow zone. Composition may depend on setup. Setup may depend only on database. No other production zone imports setup in issue #22.

Database exposes only an immutable `configured | setup-eligible` value in addition to readiness. It does not expose Drizzle, PostgreSQL rows, user identifiers, or mutation access.

The bootstrap service is inert at construction. This permits the listener to bind before any raw secret exists or is emitted.

## Startup order

1. Read and decode configuration.
2. Install configured structured logging.
3. Acquire the PostgreSQL pool.
4. Apply migrations.
5. Reconcile durable initialization.
6. Run the initial database probe.
7. Construct the bootstrap service as `inactive` or `pending` from the reconciliation result.
8. Construct the shared request runtime.
9. Bind the native HTTP listener.
10. Synchronously activate the bootstrap service.
11. Emit structured `server.ready`.
12. Wait for interruption.

Activation performs no asynchronous work between random generation, digest creation, raw output, and raw-value release. A request cannot interleave with those steps.

A configured start performs no random generation and emits no bootstrap line.

If listener binding fails, activation never runs. If activation fails after bind, Effect scope releases the listener, request runtime, and pool; startup exits non-zero without `server.ready`.

## Token generation and output

On eligible activation:

1. Obtain exactly 32 bytes from Node's cryptographic random source.
2. Encode the bytes as unpadded base64url.
3. Hash the emitted UTF-8 token with SHA-256.
4. Retain only the fixed 32-byte digest.
5. Write exactly `NAMA_BOOTSTRAP_TOKEN=<token>` followed by one newline to stdout.
6. Release the random bytes, encoded token, and output buffer immediately after the write.

The emitted token is 43 characters and carries 256 bits of source entropy.

Production output bypasses Effect logging and JSON record construction. Tests inject deterministic random bytes and a capturing line writer at bootstrap-layer construction. These are internal construction seams, not application configuration.

Activation is one-shot. Calling it again is a safe no-op and cannot rotate or repeat a token.

## State model

| State | Meaning | Secret state |
| --- | --- | --- |
| `inactive` | Durable reconciliation reported configured. | None. |
| `pending` | Setup is eligible; listener has not completed binding. | None. |
| `available` | One token was emitted and may begin setup. | SHA-256 digest only. |
| `attempting` | One valid candidate owns the exclusive setup attempt. | SHA-256 digest only. |
| `disabled` | Setup is closed for this process. | None. |

Allowed transitions:

| Event | Transition |
| --- | --- |
| Configured construction | Start in `inactive`. |
| Eligible construction | Start in `pending`. |
| Eligible activation succeeds | `pending` to `available`. |
| Valid candidate claims attempt | `available` to `attempting`. |
| Definitely pre-creation failure or interruption | `attempting` to `available`. |
| Success | `attempting` to `disabled`. |
| Possibly committed or ambiguous outcome | `attempting` to `disabled`. |
| Unresolved work after entering a commit-capable operation | `attempting` to `disabled`. |
| Process shutdown | Discard all state. |

`inactive` and `disabled` are terminal within one process. `pending` cannot accept a candidate. `attempting` cannot admit or queue another candidate.

Single-use means one successful or possibly committed administrator creation, not one malformed or definitely pre-creation request. A safely rejected pre-creation request leaves the same current-process token available.

## Candidate validation

When state is `available`, the service hashes every candidate string with SHA-256 before comparison. It compares only the two fixed-size 32-byte digests with Node's constant-time comparison primitive.

The service does not compare raw strings, decoded variable-length bytes, or variable-size buffers. Malformed, short, and long candidates follow the same digest-comparison shape and cannot cause a comparison-length exception.

An invalid candidate does not change state. No outcome contains the candidate, emitted token, digest, or arbitrary cause.

## Exclusive attempt contract

The bootstrap service exposes a scoped internal attempt operation for issue #23.

- Claim and `available` to `attempting` transition are atomic.
- The claim yields an opaque attempt capability, never the digest.
- A second claim while `attempting` fails immediately and is not queued.
- Before user creation becomes commit-capable, failure or interruption releases the claim and restores `available`.
- The attempt capability records whether its caller entered the commit-capable phase.
- Its scope finalizer restores `available` only when that phase was never entered; otherwise it destroys the digest and enters `disabled`.
- Once user creation can have committed, the attempt remains externally closed while issue #23 masks interruption through administrator creation and durable marker completion.
- Confirmed success destroys the digest and enters `disabled`.
- An ambiguous commit outcome destroys the digest and enters `disabled`; issue #23 must also make readiness fail and exit so startup reconciliation repairs or rejects durable state.
- An unresolved attempt after the commit-capable boundary fails closed as `disabled`.

Issue #22 tests these state transitions without claiming that an RPC, administrator write, or marker update exists.

## Concurrency and restart

The service admits at most one valid attempt per process at a time. It uses one atomic Effect-owned state cell; no worker, queue, mutex package, or database lock is added.

All invalid or concurrent attempts are side-effect free. They cannot rotate the token or create additional output.

Shutdown drops the digest. A new setup-eligible process generates fresh random bytes and emits a new token. The prior candidate cannot validate against the new process state. A configured restart constructs `inactive` and emits nothing.

This is a single-process design. Multi-process setup coordination remains outside the accepted deployment model.

## Failure handling

| Failure | Required behavior |
| --- | --- |
| Cryptographic random generation fails | Abort startup with `BootstrapTokenInitializationError`. Emit no token and no `server.ready`. |
| Raw stdout write fails | Abort startup with `BootstrapTokenInitializationError`. Do not retry or repeat output. Emit no `server.ready`. |
| Candidate is invalid | Fail with `BootstrapTokenInvalidError`. Preserve `available`. |
| Candidate arrives before activation | Fail with `BootstrapTokenUnavailableError`. |
| Candidate arrives during another attempt | Fail with `BootstrapTokenBusyError` without queuing. |
| Attempt fails before creation can commit | Restore `available`. |
| Attempt succeeds or may have committed | Enter `disabled` and destroy the digest. |
| Configured or disabled process receives an attempt | Fail with `BootstrapSetupClosedError`. |

The startup error has no fields beyond its stable `BootstrapTokenInitializationError` tag. `BootstrapTokenInvalidError`, `BootstrapTokenUnavailableError`, `BootstrapTokenBusyError`, and `BootstrapSetupClosedError` also have no fields. Existing `server.start_failed` handling owns the structured fatal record and resource release.

Issue #23 owns Connect codes and Nama reason details for rejected, unavailable, busy, and initialized requests. Issue #22 does not create a second public error contract.

Raw-output failure is not retried. A retry could duplicate a partially or ambiguously emitted secret. The operator restarts the failed process, which generates a new token if reconciliation remains setup-eligible.

## Secret handling

The following values never enter logs, spans, errors, health responses, database state, configuration, or test failure messages:

- raw random bytes;
- emitted bootstrap token;
- candidate bootstrap token; and
- stored digest.

The only permitted raw output is the one stdout bootstrap line. Structured stdout records remain JSON and must not contain that line or its value. Stderr never contains bootstrap secret material.

Tests may capture the raw line in memory only to exercise the behavior. Assertions avoid interpolating captured secrets into failure messages.

## Change surface

Expected implementation changes:

- add `apps/server/src/setup/bootstrap-token.ts`;
- add focused tests under `apps/server/src/setup/tests/`;
- extend `apps/server/src/database/database.ts` with immutable initialization classification;
- change `apps/server/src/database/initialization.ts` only if the classification type must be shared;
- compose and activate the service in `apps/server/src/app.ts`;
- add the approved setup boundary to `apps/server/.fallowrc.json`;
- extend `apps/server/integration/tests/process.test-support.ts` to distinguish the raw bootstrap line from structured records;
- extend `apps/server/integration/tests/process.integration.test.ts` with fresh, configured, bind-failure, output-order, and restart cases; and
- reconcile `docs/architecture.md`, `docs/architecture/core-server.md`, and `docs/architecture/authentication-and-setup.md` after implementation.

No Protobuf, generated binding, migration, Better Auth configuration, dependency, CLI, HTTP route, or logging-record change belongs to issue #22.

## Verification

### Focused service behavior

Verify:

- configured construction invokes neither RNG nor raw writer;
- eligible activation consumes exactly 32 deterministic bytes;
- output has the exact prefix, one 43-character base64url token, and one newline;
- repeated activation emits nothing further;
- the emitted token is the only valid candidate;
- malformed and arbitrary-length candidates are safely rejected through fixed-size digest comparison;
- invalid attempts preserve `available`;
- concurrent valid claims admit exactly one attempt;
- definitely pre-creation failure restores the same token;
- success disables the token and destroys its digest;
- ambiguous or unresolved commit-capable work disables the token;
- generation and output failures expose only `BootstrapTokenInitializationError`; and
- secret values do not appear in errors or structured records.

### Real process and PostgreSQL behavior

Against disposable PostgreSQL, verify:

- fresh startup emits exactly one bootstrap line;
- the bootstrap line precedes `server.ready`;
- liveness is reachable when the bootstrap line is observed;
- forced listener bind failure emits no bootstrap line;
- every non-bootstrap stdout line remains valid structured JSON;
- configured startup emits no bootstrap line;
- restarting an unused eligible server emits a different token;
- captured stdout JSON and stderr do not contain the token value.

Issue #23 must add the generated-client real-flow proof for successful consumption, reuse rejection, concurrent administrator creation, durable marker completion, ambiguous commits, and post-setup closure.

### Required gates

Run the focused server tests first. Then run `mise run check:ts`. Run repository-wide `mise run check` before issue #22 implementation is complete.

## Acceptance mapping

| Issue acceptance | Design proof |
| --- | --- |
| High-entropy token | 32 cryptographically random bytes and unpadded base64url output. |
| Operator console only | One direct stdout line; no logger, response, persistence, or other output path. |
| Replace on restart | Digest is process-local; each eligible activation generates fresh bytes. |
| Single-use | Exclusive attempt state and terminal disable after success or possible commit. |
| Never persisted | Database receives only initialization state; token and digest stay in the setup service. |
| Invalid after restart | New process has a different digest; old memory is destroyed. |
| Invalid after successful setup | Successful attempt enters terminal `disabled`; durable initialization prevents future activation. |
| Permanently closed after administrator creation | Issue #22 disables in memory; issue #23 completes and verifies durable marker mutation. |

## Documentation completion

After implementation:

- update the system architecture baseline without claiming issue #23 runtime behavior;
- mark bootstrap generation and in-memory state implemented in the core-server note;
- preserve setup/authentication handlers as unfinished;
- record the setup dependency zone and revised startup order;
- document the one raw stdout exception and its failure behavior; and
- keep generated-client setup/authentication flow explicitly pending issue #23.
