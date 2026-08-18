---
name: nama-cli
description: Use when discovering or automating Nama CLI profiles, setup, login, authentication status, JSON output, completion, schema, version, or exit handling.
---

# Nama CLI

Treat `nama` as a versioned process API. Use the real command tree for every operation.

## Discover the surface

1. Run `nama schema --output json` for machine discovery. Read `data.schema_version`, `data.commands`, and `data.exit_codes`.
2. Run `nama` or `nama help <command...>` for human help. JSON root and help requests fail with `invalid_argument` and exit 2.
3. Run `nama --version` or `nama --output json --version` for the client semantic version.
4. Generate, then explicitly install, completion with `nama completion <bash|zsh|fish|powershell>`. The command only writes a script; it does not modify shell configuration.

The implemented operation surface is `profile set`, `profile use`, `profile list`, `setup`, `auth login`, and `auth status`. `completion`, `schema`, help, and `--version` are local discovery surfaces.

## Resolve global inputs

Each setting resolves independently:

- profile selection: `--profile` → `NAMA_PROFILE` → configured default profile;
- server target: `--server` → `NAMA_SERVER` → selected profile; and
- output mode: `--output` → `NAMA_OUTPUT` → configured preferred output → `human`.

`--server` accepts an absolute HTTP or HTTPS URL without credentials, a query, or a fragment. Plain HTTP is limited to loopback, private, link-local, and `.local` targets.

For automation, pass `--output json`; do not infer JSON from whether stdout is redirected.

Local help, version, completion, and schema ignore server and profile state. An unreadable configuration falls back to human output unless `--output` or `NAMA_OUTPUT` selects a valid mode.

## Configure a profile

```bash
nama profile set local --server https://nama.example.test
nama profile use local
nama profile list --output json
```

Profiles contain non-secret server targets. Credentials remain outside the configuration file.

## Initialize the Administrator

Interactive terminals use labelled hidden prompts:

```bash
nama setup \
  --profile local \
  --display-name "Nama Administrator" \
  --email admin@example.test
```

For non-interactive setup, put the bootstrap token only in `NAMA_BOOTSTRAP_TOKEN` and send exactly one password line on redirected stdin. Apply the environment assignment to the `nama` process on the right side of the pipe:

```bash
printf '%s\n' "$NAMA_ADMIN_PASSWORD" | \
  NAMA_BOOTSTRAP_TOKEN="$NAMA_BOOTSTRAP_TOKEN" \
  nama setup \
    --profile local \
    --display-name "Nama Administrator" \
    --email admin@example.test \
    --output json
```

Never put a bootstrap token or password in an argument. JSON with terminal stdin fails before reading either secret.

## Sign in and inspect status

Interactive login:

```bash
nama auth login --profile local --email admin@example.test
```

Non-interactive login reads exactly one password line from redirected stdin:

```bash
printf '%s\n' "$NAMA_ADMIN_PASSWORD" | \
  nama auth login --profile local --email admin@example.test --output json
```

Inspect the stored credential:

```bash
nama auth status --profile local --output json
```

Automation may inject a process-only bearer through `NAMA_TOKEN` for status. Setup and login reject while `NAMA_TOKEN` is set; they never persist the injected value.

## Consume JSON and exits

A successful JSON operation writes exactly one object plus one newline to stdout and leaves stderr empty. A failed JSON operation writes exactly one error object plus one newline to stderr and leaves stdout empty. Read stable `error.code`, structured fields, and the process exit; treat English messages as presentation copy. Plain-HTTP warnings appear only in the success envelope's top-level `warnings` array.

| Exit | Meaning |
| ---: | --- |
| 0 | success |
| 1 | unexpected failure or cancellation |
| 2 | invalid arguments or configuration |
| 3 | authentication failure |
| 4 | permission denied |
| 5 | resource not found |
| 6 | conflict or invalid state |
| 7 | network or API unavailable, rate limited, or resource exhausted |

## Confirmation boundary

No implemented command is destructive. A future destructive command may prompt only with human output on a terminal. JSON and non-interactive use will require that command's explicit `--yes`; confirmation will never bypass authentication, authorization, validation, or conflict checks.
