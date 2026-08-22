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

## `nama provider`

Manage provider resources

Discover and manage provider-neutral resources recognized by the selected Nama server.

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

## `nama provider instance`

Manage configured provider instances

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

## `nama provider instance create`

Create a verified provider instance

Create a provider-neutral instance from one complete configuration. Interactive human use may render the accepted provider schema; JSON and non-interactive use read a JSON document from --configuration. Secret values belong only in prompts or that document.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-type-id` | `string` | yes | no | — | Opaque installed provider type ID |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--configuration` | `string` | no | local | — | `` | — | Read the complete JSON configuration from this file path or - for standard input (required for JSON or non-interactive use) |
| `--display-name` | `string` | yes | local | — | `` | — | Provider instance display name (required) |
| `--enabled` | `bool` | no | local | — | `true` | — | Create the provider instance enabled |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--operation-id` | `string` | no | local | — | `` | — | Reuse this opaque operation ID for an exact retry; omitted generates one |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--sync-priority` | `uint32` | no | local | — | `0` | — | Set a positive synchronization priority; omitted allocates the next priority |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider instance delete`

Permanently delete a disabled provider instance

Permanently remove a disabled provider instance and its Nama-owned state. Interactive human use prompts for confirmation; JSON and non-interactive use require --yes.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-instance-id` | `string` | yes | no | — | Opaque provider instance ID |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--expected-revision` | `string` | yes | local | — | `` | — | Require this current provider-instance revision (required) |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--operation-id` | `string` | no | local | — | `` | — | Reuse this opaque operation ID for an exact retry; omitted generates one |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |
| `--yes` | `bool` | no | local | — | `false` | — | Confirm permanent deletion without prompting (required for JSON or non-interactive use) |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider instance get`

Inspect one provider instance

Inspect one provider-neutral instance without returning write-only configuration values or credentials.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-instance-id` | `string` | yes | no | — | Opaque provider instance ID |

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
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider instance list`

List provider instances

List one page of provider-neutral instances without returning write-only configuration values or credentials.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--page-size` | `uint32` | no | local | — | `0` | — | Request up to 100 provider instances; zero uses the server default |
| `--page-token` | `string` | no | local | — | `` | — | Continue an earlier provider instance list |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider instance test`

Test a stored provider connection

Test the enabled provider instance's current stored configuration and return one safe connection observation.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-instance-id` | `string` | yes | no | — | Opaque provider instance ID |

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
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider instance update`

Update a provider instance

Patch provider-neutral metadata or configuration. Interactive human use with no update flags renders the accepted provider schema; --configuration reads a JSON patch from a file path or - for standard input. Omitted configuration and credentials remain unchanged.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-instance-id` | `string` | yes | no | — | Opaque provider instance ID |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--clear` | `stringArray` | no | local | — | `[]` | — | Explicitly clear one optional configuration field; repeat for multiple fields |
| `--configuration` | `string` | no | local | — | `` | — | Read a JSON configuration patch from this file path or - for standard input |
| `--display-name` | `string` | no | local | — | `` | — | Replace the provider instance display name |
| `--enabled` | `bool` | no | local | — | `false` | — | Enable or disable the provider instance |
| `--expected-revision` | `string` | yes | local | — | `` | — | Require this current provider-instance revision (required) |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--operation-id` | `string` | no | local | — | `` | — | Reuse this opaque operation ID for an exact retry; omitted generates one |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--sync-priority` | `uint32` | no | local | — | `0` | — | Set a positive synchronization priority |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider type`

Inspect installed provider types

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

## `nama provider type list`

List installed provider types

List the provider-neutral types, capabilities, and accepted configuration schemas recognized by the selected authenticated Nama server.

### Arguments

None.

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--page-size` | `uint32` | no | local | — | `0` | — | Request up to 100 provider types; zero uses the server default |
| `--page-token` | `string` | no | local | — | `` | — | Continue an earlier provider type list |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

## `nama provider type test`

Test a candidate provider connection

Test one complete provider configuration without creating or changing a provider instance. Interactive human use may render the accepted provider schema; JSON and non-interactive use read a JSON document from --configuration. Secret values belong only in prompts or that document.

### Arguments

| Name | Type | Required | Variadic | Allowed values | Description |
| --- | --- | --- | --- | --- | --- |
| `provider-type-id` | `string` | yes | no | — | Opaque installed provider type ID |

### Effective flags

| Flag | Type | Required | Scope | Environment | Default | Allowed values | Description |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `--configuration` | `string` | no | local | — | `` | — | Read the complete JSON configuration from this file path or - for standard input (required for JSON or non-interactive use) |
| `--help` | `bool` | no | inherited | — | `false` | — | Show help for a command |
| `--output` | `string` | no | inherited | `NAMA_OUTPUT` | `human` | `human`, `json` | Select human or json output (env: NAMA_OUTPUT) |
| `--profile` | `string` | no | inherited | `NAMA_PROFILE` | `` | — | Select a server profile (env: NAMA_PROFILE) |
| `--server` | `string` | no | inherited | `NAMA_SERVER` | `` | — | Override with an absolute HTTP(S) server URL without credentials, query, or fragment; plain HTTP is limited to loopback, private, link-local, or .local targets (env: NAMA_SERVER) |
| `--version` | `bool` | no | inherited | — | `false` | — | Print the Nama CLI semantic version |

### Conditional inputs

| Name | Type | Required | Secret | Description |
| --- | --- | --- | --- | --- |
| `bearer` | `string` | yes | yes | Administrator bearer credential |

Sources:

- `bearer`:
  - kind `environment`; source `NAMA_TOKEN`; condition `always`
  - kind `native_credential_store`; source `operating_system`; condition `NAMA_TOKEN_unset`

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
| 2 | invalid arguments or configuration | `invalid_argument`, `invalid_configuration`, `out_of_range`, `page_token_invalid`, `unsafe_transport`, `validation_failed` |
| 3 | authentication failure | `authentication_failed`, `credential_invalid`, `unauthenticated` |
| 4 | permission denied | `permission_denied` |
| 5 | resource not found | `not_found`, `profile_not_found`, `resource_not_found` |
| 6 | conflict or invalid state | `aborted`, `already_exists`, `already_initialized`, `failed_precondition`, `idempotency_key_reused`, `not_initialized`, `provider_authentication_failed`, `provider_incompatible`, `provider_instance_busy`, `provider_user_changed`, `revision_mismatch`, `setup_in_progress` |
| 7 | network or API unavailable, rate limited, or resource exhausted | `authentication_unavailable`, `deadline_exceeded`, `network_unavailable`, `plugin_unavailable`, `provider_commit_ambiguous`, `provider_credentials_unavailable`, `provider_instance_limit_reached`, `provider_unavailable`, `rate_limited`, `resource_exhausted`, `session_revocation_unconfirmed`, `setup_unavailable`, `unavailable` |
