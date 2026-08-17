# Nama CLI reference

Machine schema version: `1`. Human formatting and descriptions may evolve; automation should use `nama schema --output json`.

## `nama`

Manage a Nama server

Manage a Nama server through the implemented administration surface.

Configuration precedence
  Profile selection: --profile -> NAMA_PROFILE -> configured default profile.
  Server target: --server -> NAMA_SERVER -> selected profile.
  Output mode: --output -> NAMA_OUTPUT -> configured preferred output -> human.

Output modes
  Human output is the default. Use --output json for one machine-readable
  object on stdout on success or stderr on failure.

Exit codes
  0 success
  1 unexpected failure or cancellation
  2 invalid arguments or configuration
  3 authentication failure
  4 permission denied
  5 resource not found
  6 conflict or invalid state
  7 network or API unavailable, rate limited, or resource exhausted

Examples
  nama profile set local --server https://nama.example.test
  nama setup --profile local --display-name "Nama Administrator" --email admin@example.test
  nama auth login --profile local --email admin@example.test
  nama auth status --profile local

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | local | — | `false` | — | Show help for a command |
| `--output` | `string` | no | local | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | local | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | local | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | local | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama auth`

Manage authentication

Manage Administrator authentication. Sign in with a password or inspect the current process or native-store credential.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama auth login`

Sign in as an Administrator

Sign in with the Administrator email and a password.

Human terminal input reads the password through a labelled hidden prompt.
Non-interactive input reads exactly one password line from redirected stdin.
JSON output with terminal stdin is rejected before the password is read.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--email` | `string` | yes | local | — | `` | — | Administrator email address (required) |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `password` | `string` | yes | yes | Administrator password |

Sources:

- `password`:
  - kind `hidden_prompt`; source `Password`; condition `human_terminal`
  - kind `stdin_line`; source `stdin`; condition `nonterminal`
  - kind `rejected`; source `terminal_stdin`; condition `json_terminal`

## `nama auth status`

Report authentication status

Report whether an Administrator credential is active. NAMA_TOKEN may inject a process-only bearer instead of reading native credential storage.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | no | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama completion`

Generate a shell completion script

Generate a completion script for Bash, Zsh, Fish, or PowerShell without installing or changing shell configuration.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `shell` | `string` | yes | no | `bash`, `fish`, `powershell`, `zsh` | Shell whose completion script is generated |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama help`

Show help for a command

Show human help for the root command or one implemented command path. Use `nama schema --output json` for machine discovery.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `command` | `string` | no | yes | — | Implemented command path to describe |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama profile`

Manage server profiles

Manage named server profiles. Profiles store non-secret server targets; credentials remain in native credential storage.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama profile list`

List configured server profiles

List configured profiles and identify the selected default profile.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama profile set`

Create or update a server profile

Create or update the profile name supplied as <name>. The server target resolves from --server before NAMA_SERVER.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `string` | yes | no | — | Stable profile name |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama profile use`

Select the default server profile

Select the profile name supplied as <name> as the default for later commands.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | `string` | yes | no | — | Configured profile name |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama schema`

Describe the public CLI command contract

Print a compact human command inventory or schema version 1 as one JSON data envelope for machine discovery.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

None.

## `nama setup`

Initialize the Administrator account

Initialize the sole Administrator account.

Human terminal input reads the bootstrap token and password through labelled
hidden prompts. Non-interactive input reads NAMA_BOOTSTRAP_TOKEN from the
environment and exactly one password line from redirected stdin. JSON output
with terminal stdin is rejected before either secret is read.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--display-name` | `string` | yes | local | — | `` | — | Administrator display name (required) |
| `--email` | `string` | yes | local | — | `` | — | Administrator email address (required) |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bootstrap_token` | `string` | yes | yes | One-time server bootstrap token |
| `password` | `string` | yes | yes | Initial Administrator password |

Sources:

- `bootstrap_token`:
  - kind `hidden_prompt`; source `Bootstrap token`; condition `human_terminal`
  - kind `environment`; source `NAMA_BOOTSTRAP_TOKEN`; condition `nonterminal`
  - kind `rejected`; source `terminal_stdin`; condition `json_terminal`
- `password`:
  - kind `hidden_prompt`; source `Password`; condition `human_terminal`
  - kind `stdin_line`; source `stdin`; condition `nonterminal`
  - kind `rejected`; source `terminal_stdin`; condition `json_terminal`

## Exit codes

| Code | Meaning | Stable error codes |
| ---: | --- | --- |
| 0 | success | — |
| 1 | unexpected failure or cancellation | `canceled`, `credential_cleanup_failed`, `credential_store_unavailable`, `data_loss`, `internal`, `request_cancelled`, `unexpected_failure`, `unimplemented`, `unknown` |
| 2 | invalid arguments or configuration | `invalid_argument`, `invalid_configuration`, `out_of_range`, `unsafe_transport`, `validation_failed` |
| 3 | authentication failure | `authentication_failed`, `credential_invalid`, `unauthenticated` |
| 4 | permission denied | `permission_denied` |
| 5 | resource not found | `not_found`, `profile_not_found` |
| 6 | conflict or invalid state | `aborted`, `already_exists`, `already_initialized`, `failed_precondition`, `not_initialized`, `setup_in_progress` |
| 7 | network or API unavailable, rate limited, or resource exhausted | `authentication_unavailable`, `deadline_exceeded`, `network_unavailable`, `rate_limited`, `resource_exhausted`, `session_revocation_unconfirmed`, `setup_unavailable`, `unavailable` |
