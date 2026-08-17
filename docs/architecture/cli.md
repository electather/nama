# Management CLI

Status: issue #24 profiles, administrator setup, sign-in, and authentication status are implemented and verified. The remaining MVP command families are unfinished.

## Purpose

`nama` is the public management interface for both terminal users and shell-capable agents. [ADR-0015](../adr/0015-thin-management-cli.md) keeps it a thin Go 1.26 client over generated Connect-Go services, not a second implementation of server behavior. Commands, flags, structured output, errors, and exit codes form a versioned public contract.

The CLI remains useful without an interactive terminal. Every operation has a complete non-interactive form, and interactive affordances may only wrap those same operations later.

## Scope and delivery

The complete MVP management surface covers initial administrator setup, authentication and server profiles, plugin and Jellyfin configuration, synchronization status and triggering, device approval, health, and diagnostics. Command families enter with the server RPCs they exercise:

- Milestone 0 created the compilable Cobra boundary and proved that generated public clients are consumable.
- Issue #24 implements the shared CLI foundation, named profiles, administrator setup, sign-in, and authentication status.
- Health, diagnostics, plugin, Jellyfin, device, and synchronization commands enter only with their implemented API behavior.

The repository also ships one installable Codex `SKILL.md` with command discovery, JSON use, safe setup and configuration flows, and confirmation boundaries. There is no management web application or CLI plugin framework in the MVP.

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
      v
generated Connect-Go clients
      |
      v
Nama api.v1
```

A command normally performs four steps:

1. Parse arguments, flags, and inherited configuration.
2. Validate constraints specific to invoking the command.
3. Call one application operation backed by generated Connect-Go clients.
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
│   └── status
├── profile
├── plugin
│   └── jellyfin
├── sync
│   ├── status
│   └── run
├── devices
│   └── approve
├── health
├── diagnostics
├── completion
└── schema
```

Only commands backed by an implemented public RPC are added. Exact leaf commands, arguments, and flags are designed with those RPCs; this list reserves no unimplemented server behavior.

The canonical binary name is `nama`. The issue #24 command tree supplies Cobra's standard static help. Version reporting, shell completion, generated command documentation, and compatibility snapshots remain deferred to issue #25.

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
`profile set` ignores inherited profile selection but still resolves `--server` and `NAMA_SERVER`. `profile list` and `profile use` ignore both inherited profile and server selections because those inputs are irrelevant to their local configuration operations.

The client permits plain HTTP only for loopback, private or link-local addresses, and `.local` discovery names, with the warning required by the authentication design. For these permitted plain-HTTP targets it bypasses environment proxies; HTTPS retains the caller's configured proxy behavior. Public names and addresses require HTTPS. Human rendering visibly escapes untrusted terminal controls returned by a server.

## Discovery and compatibility

One constructed Cobra tree drives human help, shell completion, generated Markdown documentation, machine-readable schema, and the compatibility snapshot. Generated Markdown lives under `docs/cli/` and is checked for drift in CI once real commands exist.

`nama schema --output json` describes canonical command paths, positional arguments, flags, types, requirements, and descriptions by walking the actual command tree. It is generated rather than maintained as a parallel registry.

Released commands, positional arguments, flags, JSON fields, error codes, and exit-code meanings are compatibility surfaces. CI compares the current command schema with the released snapshot and reports removals or incompatible changes for explicit review. Additive commands, flags, and JSON fields are normally compatible. Human formatting is not snapshot-compatible.

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

The implemented issue #24 surface is tested in process through the real Cobra tree with injected arguments, context, streams, configuration location, credential store, secret reader, and generated service clients. Coverage includes:

- profile persistence, resolution precedence, URL policy, and credential-deletion ordering;
- terminal and non-interactive secret input plus native-credential semantics;
- generated-client metadata, deadlines, and method-specific bearer attachment over test Connect handlers;
- setup recovery, sign-in replacement, authentication status, revocation, cleanup, and typed errors;
- exact JSON stream behavior plus human warning and prompt placement, exit codes, and secret redaction; and
- a compiled-binary status flow against a test Connect server using a process-injected credential.

The owning Go check runs formatting, vet, Staticcheck, tests, and compilation. A disposable Node server, PostgreSQL database, and macOS Keychain flow additionally verifies administrator setup and stored-credential status on macOS; it is not portable keyring evidence. Generated CLI documentation, command-surface snapshots, expanded help/version/completion, and their compatibility enforcement remain deferred.

## Deferred

The initial CLI does not include a TUI, fuzzy selection, complex themes, pervasive spinners, MCP server, CLI plugin architecture, or Viper configuration layer. Fang, Huh, and Bubble Tea enter only when an implemented workflow demonstrates that Cobra and the shared output layer are insufficient.

The governing principle is simple: the CLI is a public API transported through a Unix process. Boring routing, generated transport, and stable machine contracts take priority over presentation novelty.
