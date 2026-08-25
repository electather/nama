# Management CLI

Status: issue #24 profiles, Administrator setup/sign-in, and authentication status; issue #25's complete public process contract; issues #76–#80's provider type and provider-instance CRUD surface plus durable tracer; issue #107's restricted-schema interactive create/update workflow; and issue #31's candidate and stored-instance connection tests are implemented and verified. The remaining MVP command families are unfinished.

## Purpose

`nama` is the public management interface for both terminal users and shell-capable agents. [ADR-0015](../adr/0015-thin-management-cli.md) keeps it a thin Go 1.26 client over generated Connect-Go services and, for issue #145's OAuth approval only, Better Auth's native device HTTP routes—not a second implementation of server behavior. Commands, flags, structured output, errors, and exit codes form a versioned public contract.

The CLI remains useful without an interactive terminal. Every operation has a complete non-interactive form, and interactive affordances may only wrap those same operations.

## Scope and delivery

The complete MVP management surface covers initial Administrator setup, authentication and server profiles, Apple device-code approval, provider configuration, synchronization status and triggering, broad first-party OAuth grant revocation, health, and diagnostics. Command families enter with the server boundaries they exercise:

- Milestone 0 created the compilable Cobra boundary and proved that generated public clients are consumable.
- Issue #24 implements the shared CLI foundation, named profiles, administrator setup, sign-in, and authentication status.
- Issue #25 completes help, version reporting, shell completion, machine schema, generated reference documentation, and semantic compatibility enforcement.
- Issue #76 adds the provider-neutral `nama provider type list` command over the implemented authenticated RPC.
- Issue #77 adds provider-neutral instance create, list, and get commands over the verified candidate and encrypted persistence flow.
- Issue #78 adds revision-checked provider-instance patch, explicit clear, disable, and re-enable over the verified candidate and runtime-cutover flow.
- Issue #79 adds revision-checked permanent deletion with interactive confirmation and an explicit non-interactive `--yes` boundary.
- Issue #80 proves those commands as one restart and upgrade flow against the production server, PostgreSQL, supervisor, Jellyfin plugin, and a disposable Jellyfin server.
- Issue #107 adds ordered restricted-schema prompts for human create and update while preserving complete file/stdin automation and JSON no-prompt behavior.
- Issue #31 adds provider-neutral candidate and stored-instance connection tests while retaining provider-type listing as the installed capability-inspection surface.
- Issue #145 adds `nama auth approve-device <user-code>` over Better Auth's native device routes plus broad fixed-client refresh-family revocation.

The repository ships the `nama-cli` skill with command discovery, JSON use, safe setup and authentication flows, and confirmation boundaries. There is no general management web application or CLI plugin framework in the MVP. Issue #145 makes Apple authorization complete through the CLI; issue #167 separately owns optional browser approval.

## Technology

The CLI uses:

- Go 1.26;
- Cobra for commands, arguments, flags, help, and Bash, Zsh, Fish, and PowerShell completion;
- generated Connect-Go clients over the standard library HTTP client;
- one shared output layer and one shared error-to-exit-code mapping; and
- OS-native credential storage where available.

Cobra stays deliberately boring. It parses CLI input, validates CLI-specific constraints, calls an application operation, and sends the result to the output layer. Business rules stay in the core server. A generated client is wrapped only when the CLI has an actual shared concern such as authentication, pagination, error translation, or common request options.

Fang may later improve human-facing help and error presentation without replacing Cobra. Huh may later add small prompts or forms over existing non-interactive commands. Bubble Tea requires a demonstrated need for a stateful terminal application. None of these optional presentation dependencies belongs in the initial implementation.

## Architecture

```text
human or agent
      |
      v
Cobra commands
      |
      v
application operations
      |
      ├──> generated Connect-Go clients ──> Nama api.v1
      |
      └──> Better Auth device HTTP routes ──> OAuth approval
```

A command normally performs four steps:

1. Parse arguments, flags, and inherited configuration.
2. Validate constraints specific to invoking the command.
3. Call one application operation through its generated Connect-Go client or explicit Better Auth device HTTP boundary.
4. Return a Go value or typed error to the root output handler.

Commands do not select exit codes, print errors, format JSON independently, contain persistence rules, or reproduce server authorization and validation.

## Command surface

Commands are grouped by explicit resources and use canonical nouns and verbs. Documentation and generated discovery output expose full names rather than abbreviations. The intended families are:

```text
nama
├── setup
├── auth
│   ├── login
│   ├── logout
│   ├── status
│   └── approve-device
├── profile
├── provider
│   ├── type
│   │   ├── list
│   │   └── test
│   └── instance
│       ├── list
│       ├── get
│       ├── create
│       ├── update
│       ├── test
│       └── delete
├── sync
│   ├── status
│   └── run
├── health
├── diagnostics
├── completion
└── schema
```

Only commands backed by an implemented public RPC or issue #145's standard
Better Auth device-approval routes are added. Exact leaf commands, arguments,
and flags are designed with their owning boundary; this list reserves no other
unimplemented server behavior.

`nama auth approve-device <user-code>` requires an active Administrator session
for the selected endpoint and uses the existing signed bearer from its profile
or `NAMA_TOKEN`. It first calls Better Auth's native `GET /device` route to
validate and claim the code, then `POST /device/approve` with the same session.
It does not ask for a password, mint a session, or call Connect. Terminal and
JSON output map invalid, expired, already-processed, and unauthorized codes to
stable safe failures without printing the session bearer or code in diagnostics.

Issue #145 also adds one destructive Administrator-authenticated operation
under `nama auth` that revokes every Better Auth refresh-token family for the
fixed first-party Apple client. Its exact leaf name and generated request are
added only with the owning RPC. It does not list installations or promise
immediate invalidation of already-issued access JWTs; human mode confirms the
broad effect, and non-interactive or JSON use requires `--yes`.

Provider commands are generic `ProviderService` clients; no Jellyfin-specific
public command family exists. Implemented create, update, and delete generate a
random operation ID unless the caller supplies `--operation-id` for scripted
retry or ambiguity recovery, and mutation JSON output includes the ID used.
Update and delete require `--expected-revision`; the CLI never fetches a newer
revision and silently overwrites or removes it. Provider delete prompts only in
interactive human mode. JSON or non-interactive deletion requires explicit
`--yes` and never reads configuration or credentials.

`nama provider type list` is the installed provider capability-inspection
surface. `nama provider type test` checks one complete candidate configuration,
and `nama provider instance test` checks one enabled stored instance. Both
return the safe connection observation under `data.connection_test`. A
completed `CONNECTED`, `AUTHENTICATION_FAILED`, `UNREACHABLE`, or
`INCOMPATIBLE` observation exits successfully; automation inspects its status.
Invocation, authentication, authorization, transport, and unexpected server
failures retain the central error and exit-code contract.

Human provider create without `--configuration` renders the selected provider
type's flat restricted schema. A human update with no explicit update flags
loads the current instance and renders that provider type's schema. Controls
derive type, enum, format, title, description, default, and order; submitted
values receive the schema's local length, range, collection, enum, and format
checks before the server authoritatively revalidates them.
Schema defaults prefill controls only. Existing ordinary values are retained when accepted unchanged,
and blank hidden `writeOnly` input retains an existing secret while non-empty
input replaces it. Non-interactive and JSON forms read a configuration or patch
document from a file path or `-` for stdin and never prompt. Provider secret
values are never accepted in argv, environment variables, positional
arguments, or inline JSON flags. `--clear <key>` continues to name optional
ordinary or secret fields without carrying their values.

The canonical binary name is `nama`. The live Cobra tree now supplies complete human help, a global version flag, four shell-completion formats, machine schema version 1, the generated CLI reference, the compatibility baseline, authenticated provider-type listing and candidate testing, and provider-instance create/list/get/update/test/delete.

## Output contract

The global `--output` flag accepts `human` or `json`. Human output is the default; scripts and agents must explicitly request `--output json`. Both modes execute the same operation and differ only in rendering.

In JSON mode:

- successful stdout is exactly one JSON object followed by a newline;
- failed stderr is exactly one JSON error object followed by a newline;
- successful stdout contains no progress, color, prompts, logs, or decorative prose;
- allowed plain-HTTP warnings appear only as a structured top-level `warnings` collection in the success object;
- successful stderr remains empty, including when the success object contains warnings;
- dates use RFC 3339 in UTC;
- public identifiers remain strings;
- field names and optional-value behavior are stable; and
- commands never silently switch to interactive behavior.

Successful values use a top-level data envelope:

```json
{
  "data": {
    "status": "serving"
  }
}
```

Failures use an error envelope:

```json
{
  "error": {
    "code": "resource_not_found",
    "message": "The requested resource was not found"
  }
}
```

Human tables and prose may evolve without a compatibility guarantee. Automation must use JSON rather than parse human presentation.

## Errors and exit codes

Application operations return typed CLI errors containing a stable code, safe message, exit code, and an internal cause. The root command renders each error once, suppresses Cobra's duplicate usage/error output, and never exposes the internal cause, token, password, credential, or provider response body in structured output. JSON renders a positive `retry_delay` as a unit-bearing duration string and omits it when absent.

The stable exit codes are:

```text
0  success
1  unexpected failure
2  invalid arguments or configuration
3  authentication failure
4  permission denied
5  resource not found
6  conflict
7  network or API unavailable
```

Connect errors map centrally to this model. Generated clients use a private HTTP/1-only clone of a standard-library `*http.Transport` and refuse redirects, so mutation bodies and bearer headers cannot be replayed automatically or forwarded to another origin. A non-`*http.Transport` client fails closed because its HTTP/1 behavior cannot be guaranteed without taking ownership of caller state. Retries remain bounded and limited to operations known to be safe to repeat; mutations are not retried merely because a transport failed.

## Authentication and credentials

`nama auth login` accepts an email address and reads a password interactively from a labelled hidden prompt or non-interactively from redirected stdin. JSON mode rejects terminal stdin before reading. A password is never accepted as a command-line flag, persisted, or written to logs. Login exchanges the password for a server-issued session or token, and only that credential may be stored.

Persistent tokens use the operating system credential facility where available:

```text
macOS    Keychain
Windows  Credential Manager
Linux    Secret Service
```

When native credential storage is unavailable, the CLI does not silently write a plaintext token. Native records bind the bearer and expiry to the canonical full server target. Malformed and legacy unbound records never attach: the CLI deletes them and treats them as absent, while a failed deletion returns the typed credential-cleanup error and stops the operation. Automation may inject a token for authentication status in the current process through the documented environment variable. Setup and login reject while that injection is active so a newly issued bearer cannot be orphaned. Any future file-backed fallback requires an explicit design amendment and owner-only permissions.

## Configuration and profiles

Configuration remains small and contains no credentials. It records named profiles, each profile's server URL, the selected default profile, and the preferred output mode. The CLI stores it below the directory returned by the operating system's user-configuration convention.

Values resolve in this order:

```text
CLI flag
  -> NAMA_* environment variable
  -> selected profile
  -> built-in default
```

The shared global inputs are `--server`, `--profile`, and `--output`, with corresponding `NAMA_SERVER`, `NAMA_PROFILE`, and `NAMA_OUTPUT` variables. Profile configuration never contains passwords or tokens.

Provider configuration documents are per-command input, not CLI configuration.
They are never copied into profiles or the native administrator credential
store. A caller that uses a file owns that file's permissions and deletion;
stdin is the preferred automation path for write-only values.
`profile set` ignores inherited profile selection but still resolves `--server` and `NAMA_SERVER`. `profile list` and `profile use` ignore both inherited profile and server selections because those inputs are irrelevant to their local configuration operations.

The client permits plain HTTP only for loopback, private or link-local addresses, and `.local` discovery names, with the warning required by the authentication design. For these permitted plain-HTTP targets it bypasses environment proxies; HTTPS retains the caller's configured proxy behavior. Public names and addresses require HTTPS. Human rendering visibly escapes untrusted terminal controls returned by a server.

## Discovery and compatibility

One constructed Cobra tree drives human help, shell completion, generated reference documentation, machine-readable schema, and the compatibility baseline. Hidden framework plumbing is excluded.

`nama schema --output json` is the machine-discovery surface. Schema version 1 describes canonical command paths, ordered positional arguments, effective flags and inheritance, conditional secret inputs without values, and the full exit/error mapping. `docs/cli/reference.md` is the deterministic, timestamp-free human reference generated from the same metadata.

The committed schema-v1 milestone baseline permits additive optional commands, flags, arguments, inputs, and allowed values. It rejects removals and renames; newly required inputs; type, source, environment-binding, static-default, or inheritance changes; allowed-value removals; exit/error remapping; and schema-field removal or type changes. Descriptions and human copy may evolve independently.

## Destructive operations

A destructive command may prompt only when human output is selected and stdin is an interactive terminal. Non-interactive input and JSON mode never prompt; they fail unless the caller supplies `--yes`. Confirmation does not bypass authentication, authorization, server validation, or conflict handling.

Interactive workflows added later must call the same application operation as their explicit command form. No operation may require a TUI, fuzzy selector, or prompt.

## Repository layout

```text
apps/cli/
├── cmd/nama/
│   └── main.go
└── internal/
    ├── cli/
    │   ├── root.go
    │   └── <resource>/
    ├── app/
    ├── api/
    ├── auth/
    ├── config/
    ├── output/
    ├── clierror/
    ├── schema/
    └── surface/
```

`cmd/nama/main.go` is only the composition root. Cobra-specific construction stays in `internal/cli`; resource subpackages are added only when their commands exist. `internal/app` contains thin application operations, `internal/api` constructs generated clients, and the remaining packages each own the single cross-command concern named by their directory.

No empty package or interface is created in anticipation of a later command. A concrete dependency remains concrete until tests or multiple implementations create a present need for a boundary.

## Testing

The implemented surface is tested in process through the real Cobra tree with injected arguments, context, streams, configuration location, credential store, secret reader, and generated service clients. Coverage includes:

- profile persistence, resolution precedence, URL policy, and credential-deletion ordering;
- terminal and non-interactive secret input plus native-credential semantics;
- generated-client metadata, deadlines, and method-specific bearer attachment over test Connect handlers;
- setup recovery, sign-in replacement, authentication status, revocation, cleanup, and typed errors;
- provider-type and provider-instance page input, authenticated profile selection, candidate and stored-instance connection tests, completed-result status rendering, ordered restricted-schema prompts, defaults, hidden write-only input, secret omission and replacement, file/stdin configuration and patch input, JSON no-prompt behavior, explicit clears, operation IDs, expected revisions, delete confirmation and `--yes`, and human/JSON rendering;
- exact JSON stream behavior plus human warning and prompt placement, long terminal content, exit codes, update and deletion conflicts, and secret redaction; and
- compiled-binary production server/PostgreSQL/Jellyfin flows covering discovery, CLI candidate and stored-instance connection tests, verified encrypted create, durable restart recovery, accepted-schema upgrade and damaged-credential containment beside healthy mutation, credential replacement, same-principal enforcement, disable/re-enable, safe deletion and exact replay across restarts, list/get, validation, disabled-user rejection, idempotency, pagination misuse, and security sentinels.

The owning Go check runs formatting, vet, Staticcheck, tests, compilation,
generated-reference drift, schema-v1 semantic compatibility, and the clean
source-build version contract. Focused in-process coverage uses the real Cobra
tree for schema order, defaults, hidden prompts, secret
omission/replacement, file/stdin input, JSON no-prompt behavior, long content,
and exact stream placement. The durable compiled flow retains the real
server/PostgreSQL/Jellyfin management boundary; the macOS Keychain flow
separately verifies Administrator setup and stored-credential behavior.

## Deferred

The initial CLI does not include a TUI, fuzzy selection, complex themes, pervasive spinners, MCP server, CLI plugin architecture, or Viper configuration layer. Fang, Huh, and Bubble Tea enter only when an implemented workflow demonstrates that Cobra and the shared output layer are insufficient.

The governing principle is simple: the CLI is a public API transported through a Unix process. Boring routing, generated transport, and stable machine contracts take priority over presentation novelty.
