# CLI Setup, Sign-In, and Status Design

Status: approved design for issue #24.

## Goal

Deliver the first secure management CLI flow against the implemented public Setup and Auth RPCs. An operator can persist a server target, initialize exactly one administrator, sign in, and inspect authentication status. Every flow supports human output. The complete setup flow supports non-interactive execution with parseable JSON.

## Scope

Issue #24 adds:

- named server profiles and default-profile selection;
- global server, profile, and output resolution;
- administrator setup followed by sign-in;
- later administrator sign-in;
- authentication status;
- native credential storage;
- the shared API, output, error, and secret-input foundations required by these commands.

Issue #24 does not add sign-out, health, diagnostics, generated documentation, command schema or compatibility snapshots, shell completion, the repository operation skill, or server behavior. Issue #25 extends help, version, completion, JSON parity, exit-code documentation, and compatibility enforcement without replacing the contracts introduced here.

Public signup, invitations, password recovery, OAuth/OIDC, additional roles, a web UI, and database storage of the bootstrap token remain excluded.

## Design decisions

Use a vertical slice on concrete shared owners. Cobra commands bind CLI input and call application operations. Application operations own orchestration. Generated Connect-Go clients own the wire boundary. Dedicated concrete packages own profiles, credentials, errors, and output.

Do not put RPC policy, persistence, rendering, or exit-code selection in individual commands. Do not add a generic command registry, generic operation framework, plaintext credential fallback, Viper, Fang, Huh, Bubble Tea, or speculative interfaces.

Add exactly two direct dependencies:

- `github.com/zalando/go-keyring` for macOS Keychain, Windows Credential Manager, and Linux Secret Service;
- `golang.org/x/term` for terminal detection and no-echo secret input.

Pin both through the Go module manifest and lock state.

## Command surface

| Command | Purpose |
| --- | --- |
| `nama profile set <name> --server <url>` | Create or update a named server target. |
| `nama profile use <name>` | Select the default profile. |
| `nama profile list` | List profiles in deterministic name order and identify the default. |
| `nama setup --display-name <name> --email <email>` | Create the sole administrator, sign in, and store the bearer. |
| `nama auth login --email <email>` | Sign in and store a replacement bearer for the selected profile. |
| `nama auth status` | Report whether the selected target has a usable administrator credential. |

The root exposes inherited `--profile`, `--server`, and `--output` flags. The corresponding environment variables are `NAMA_PROFILE`, `NAMA_SERVER`, and `NAMA_OUTPUT`.

Profile selection resolves from `--profile`, `NAMA_PROFILE`, then the configured default. Server selection resolves from `--server`, `NAMA_SERVER`, then the selected profile; there is no built-in server. Output selection resolves from `--output`, `NAMA_OUTPUT`, the configured global preference, then the built-in human default. JSON must be requested explicitly.

Profile names are 1 through 64 lowercase ASCII letters, digits, periods, underscores, or hyphens. The first character is a letter or digit. Names are compared exactly.

## Input behavior

`setup` requires a selected named profile. It rejects an explicit server override that differs from the selected profile URL. `auth login` has the same requirement. This gives every returned credential one stable storage identity.

Interactive setup reads the bootstrap token and password from no-echo terminal prompts. Non-interactive setup requires `NAMA_BOOTSTRAP_TOKEN` and reads one password line from stdin. Display name and email remain explicit flags.

Interactive login reads the password from a no-echo terminal prompt. Non-interactive login reads one password line from stdin.

No command accepts a password flag or password environment variable. No command accepts the bootstrap token as an argument. A missing required non-interactive secret is an argument error; the CLI never switches to prompting when stdin is not a terminal or JSON output is selected.

## Component ownership

### Process and commands

`apps/cli/cmd/nama` remains the composition root. It supplies process context, arguments, standard streams, build metadata, the native credential backend, and the user config location to the CLI root.

`apps/cli/internal/cli` constructs the Cobra tree and binds arguments. Resource subpackages are added only for profile, setup, and auth commands. The root renders each result or error once and returns the selected exit code.

### Application operations

`apps/cli/internal/app` contains concrete operations for profile mutation, setup, login, and auth status. Operations accept resolved inputs and generated service clients. They return Go result values or typed CLI errors. They do not print or select exit codes.

### API client

`apps/cli/internal/api` constructs generated Setup and Auth clients over one standard-library HTTP client. Every request carries:

- client name `nama-cli`;
- client platform `go`;
- semantic client version from Go build information.

An unreleased local build reports `0.0.0-dev`. Issue #25 may expose the same build information through the version command; it must not introduce a second source.

Each current RPC has a 30-second deadline. Setup recovery uses a fresh bounded context after an ambiguous creation result. The client performs no automatic mutation retry. It does not disable TLS verification or add alternate transports.

Bearer attachment is explicit for protected calls. Setup status, administrator creation, and sign-in never receive a stored bearer merely because one exists.

### Configuration

`apps/cli/internal/config` stores non-secret JSON configuration at `os.UserConfigDir()/nama/config.json`. The file records named profile URLs, the selected default profile, and one global preferred output mode. This issue initializes that preference to human, reads any valid persisted value, and preserves it during profile mutations. Writes use a same-directory temporary file, sync, and atomic replacement. The directory is owner-only and the file is owner-readable and owner-writable where the operating system supports Unix permissions.

Malformed configuration fails closed. A command never rewrites a malformed file with defaults. Profile listing is deterministic.

Configuration never contains bearer credentials, passwords, bootstrap tokens, request bodies, arbitrary headers, or keyring payloads.

### Credentials and secret input

`apps/cli/internal/auth` owns secret input and credential persistence. Keyring service name is `nama-cli`. The keyring account is the profile name. A record contains only the bearer and its expiry.

`NAMA_TOKEN` overrides keyring lookup for the current process. An injected bearer is never persisted, replaced, or deleted.

A missing keyring record is a normal signed-out state for `auth status`. An unavailable or failing credential backend is an operational error. The CLI never falls back to a file.

Changing a profile URL first deletes the old profile credential. If deletion fails, the configuration change fails and the old URL remains. Repeating `profile set` with the same normalized URL preserves the credential.

If an explicit server override differs from the selected profile URL, the client never attaches that profile's stored bearer. `auth status` may use `NAMA_TOKEN` against the override; without it, status reports signed out. With no selected profile, `auth status` requires an explicit server and omits the profile field from its result.

### Output and errors

`apps/cli/internal/output` is the only success and failure renderer. `apps/cli/internal/clierror` owns stable CLI codes, safe messages, exit codes, optional request IDs, normalized field violations, retry delay, and private causes.

Internal causes are never rendered. Connect translation branches on Connect code, then on known `google.rpc.ErrorInfo.reason`. Unknown reasons fall back to the Connect code. Server field violations pass through only after safe normalization. Error details never include submitted values.

## Server URL policy

A target must be an absolute HTTP or HTTPS URL without user information, query, or fragment. Normalize scheme and host casing and remove only a redundant trailing slash. Preserve a non-root path for user-managed reverse proxies.

HTTPS is accepted for public and private targets. Plain HTTP is accepted only for:

- loopback IP literals;
- private or link-local IP literals;
- `localhost` and its subdomains;
- names ending in `.local`.

Do not resolve an arbitrary hostname to weaken this rule. Every accepted plain-HTTP target produces an `insecure_transport` warning.

## Operation flows

### Profile operations

`profile set` validates and normalizes the URL before touching persistent state. A changed URL removes the corresponding keyring record before committing the config update. The operation is idempotent for the same normalized name and URL.

`profile use` requires an existing profile. `profile list` succeeds with an empty collection when no profiles exist.

### Setup

1. Resolve and validate profile, server, output mode, and secret inputs.
2. Call public `SetupService.GetStatus`.
3. If the server was already initialized before this attempt, return `already_initialized`. Do not reinterpret setup as login.
4. Call `SetupService.CreateAdministrator` exactly once.
5. On an unambiguous application failure, return the translated error.
6. On a transport-ambiguous creation result, call `GetStatus` with a fresh bounded recovery context. Continue only when it reports initialized. Preserve the original failure when it reports uninitialized. Return setup-unavailable ambiguity when status cannot establish the state. Never replay administrator creation.
7. Call `AuthService.SignIn` exactly once with the same email and password.
8. Store the returned bearer and expiry in keyring.
9. If storage fails, call `AuthService.SignOut` with the in-memory bearer. Return the storage error only after confirmed revocation. If revocation cannot be confirmed, return `session_revocation_unconfirmed`. Never render the bearer.

A successful setup reports initialized and signed in. It returns the public administrator fields and credential expiry, never the credential.

### Login

Call `AuthService.SignIn` exactly once. A failed sign-in leaves any existing keyring record untouched. Before replacing a record after successful sign-in, retain the prior record in memory.

Write the new record without deleting the prior record first. If the write fails, re-read the account and restore the prior record when the backend changed it. Revoke the new in-memory bearer. Revocation ambiguity takes precedence over a credential restoration error because it may leave an active unknown session; otherwise report any restoration failure as a credential-store operational error.

### Authentication status

Resolve `NAMA_TOKEN` first, then the selected profile keyring record when the effective server matches the profile URL.

When no credential exists, return success with signed-in state false. When a credential exists, call `AuthService.GetCurrentUser`.

A valid credential returns signed-in state true and the public administrator. Include credential expiry only when it is known from a stored record.

A rejected injected credential remains untouched and returns authentication failure. A rejected stored credential is deleted and returns authentication failure. If deletion fails, return a credential-cleanup operational error that states the credential is invalid without exposing it.

## Output contract

Human output uses concise labelled fields. Human formatting is not a compatibility surface.

JSON success writes exactly one object followed by one newline to stdout. The object has a top-level `data` member. JSON failure writes exactly one object with a top-level `error` member followed by one newline to stderr and leaves stdout empty. JSON mode emits no prompts, progress, color, logs, or prose.

Setup data contains profile, server, initialized state, signed-in state, administrator, and credential expiry. Login data contains profile, server, signed-in state, administrator, and credential expiry. Status data contains server and signed-in state; profile is present only when one was selected, while administrator and expiry are present only under the conditions defined above. Profile results contain profile names, normalized URLs, and default selection state.

Allowed plain HTTP adds a structured top-level warnings collection to the single JSON success object. Omit the collection when empty. Human mode writes the warning to stderr. JSON mode writes no warning prose to stderr.

Administrator output contains only opaque ID, display name, and normalized email. Credentials and submitted secrets are absent from all output modes.

## Error and exit contract

JSON error output contains a stable lowercase CLI code and safe message. It may contain a server request ID, normalized field violations, and retry delay. Omit unavailable optional values consistently.

Exit codes are:

| Exit | Meaning |
| --- | --- |
| 0 | Success, including auth status with no local credential. |
| 1 | Unexpected failure, local operational failure, or cancellation. |
| 2 | Invalid arguments, unsafe URL, malformed configuration, or missing selected profile. |
| 3 | Sign-in failure or rejected, expired, or revoked bearer. |
| 4 | Permission denied. |
| 5 | Requested profile or resource not found when absence is an error. |
| 6 | Setup conflict, setup in progress, not initialized, or already initialized. |
| 7 | Network/API unavailable, deadline, setup ambiguity, revocation ambiguity, or rate limit. |

Known server reasons retain their stable meaning through lowercase CLI codes. Local errors use a small allowlist for invalid arguments, invalid configuration, profile not found, credential-store unavailable, credential cleanup failure, unsafe transport, network unavailable, and unexpected failure.

An explicitly requested missing profile is exit 5. Failure to resolve any profile for an operation that requires one is invalid configuration and exit 2.

The CLI never prints a raw Connect error, HTTP response body, arbitrary response header, keyring error, stack trace, password, bootstrap token, bearer, or config contents.

## Testing

Write each focused behavior test before its implementation and observe the intended failure.

Automated Go coverage includes:

- command parsing and operation inputs through the real Cobra tree;
- profile create, update, use, list, precedence, normalization, atomic persistence, malformed state, and credential deletion ordering;
- URL boundaries for HTTPS, loopback, private/link-local IPv4 and IPv6, `localhost`, `.local`, public HTTP, user information, and reverse-proxy paths;
- terminal and non-interactive secret input without echo or fallback;
- environment and keyring credential precedence;
- client metadata and method-specific bearer attachment;
- every setup success, application-failure, and ambiguous-creation branch, including proof that creation is called once;
- login replacement and preservation rules;
- all three status states: absent, valid, and rejected credential;
- keyring storage, cleanup, and revocation failures;
- exact JSON stream placement and newline behavior;
- human warnings, JSON warnings, field violations, request IDs, exit mapping, and secret redaction.

Command tests inject context, arguments, streams, config location, credential store, and generated client interfaces. Wire tests use generated Connect handlers on `httptest.Server`. Do not create a handwritten parallel HTTP client or duplicate public DTOs.

A focused compiled-command smoke verifies profile targeting, process exit, stream placement, and JSON parsing. Against a test Connect server, it exercises authenticated status with `NAMA_TOKEN`, so it does not depend on a CI keyring. `mise run check:go` remains the owning automated check. Do not add a root task.

## Real-flow verification

Exercise the implemented feature against the actual Node server and disposable PostgreSQL on the development workstation:

1. Build the `nama` binary.
2. Start an uninitialized server and capture its single documented bootstrap-token emission.
3. Create and select an isolated profile targeting that server.
4. Run setup non-interactively in JSON mode with the token in `NAMA_BOOTSTRAP_TOKEN` and password on stdin.
5. Parse the single JSON success object and verify initialized and signed-in state without a credential value.
6. Run `auth status` through the stored isolated macOS Keychain credential and parse its JSON success object.
7. Confirm exactly one administrator exists and the server accepts the stored session.
8. Scan CLI output, public failures, and server logs for the password, bootstrap token, and bearer. Exclude only the server's one documented bootstrap-console emission.
9. Remove the isolated keychain record and config state.

Report this as local macOS evidence. Do not claim portable CI keyring coverage from it.

Final verification order is focused tests, `mise run check:go`, the real-flow smoke, then `mise run check`.

## Implementation boundary

Expected implementation changes are limited to handwritten files under `apps/cli/`, `go.mod`, and `go.sum`, followed by implementation-status reconciliation in `docs/architecture/cli.md` and `docs/architecture/authentication-and-setup.md` after runtime verification proves the behavior.

Do not change Protobuf schemas, generated bindings, server code, database state, root tasks, generated CLI documentation, or the repository operation skill for issue #24.
