---
name: nama-cli-operation
description: Use when operating Nama's CLI for server profiles, Administrator setup or sign-in, or authentication status.
---

# Nama CLI operation

Operate only the command tree exposed by the exact Nama executable in the current environment. Runtime help is executable truth; architecture and release plans may describe work that is not available.

The current operational leaf allowlist is:

- `profile list`
- `profile set <name>`
- `profile use <name>`
- `setup`
- `auth login`
- `auth status`

Configuration in this playbook means named server-profile configuration only. Treat every other path absent from runtime help as unavailable.

## Establish one command prefix

1. Use an executable or command prefix explicitly supplied by the operator.
2. Otherwise, use `nama` when it is already available in the environment.
3. Otherwise, from the repository root use the current source composition root: `go run ./apps/cli/cmd/nama`.
4. Never download, install, or silently substitute another CLI. Keep the selected prefix unchanged through discovery, mutation, and verification.

For Bash or Zsh, preserve a multi-word prefix in an array:

```bash
# Choose exactly one:
nama_cmd=(nama) # supplied or already available executable
# nama_cmd=(go run ./apps/cli/cmd/nama) # source fallback from repository root
```

Before an unfamiliar operation, inspect root help, then the relevant family and leaf help through that same prefix:

```bash
"${nama_cmd[@]}" --help
"${nama_cmd[@]}" profile --help
"${nama_cmd[@]}" profile set --help
```

Use `auth --help` and the relevant `auth` leaf help for authentication work. Construct an invocation only from commands and flags shown by this runtime help. Repeat discovery after changing the prefix or executable version.

## Pin targeting and machine output

Global values resolve in this order:

| Input | Precedence | Built-in state |
| --- | --- | --- |
| server profile | `--profile` → `NAMA_PROFILE` → configured default profile | none |
| server URL | `--server` → `NAMA_SERVER` → selected profile's URL | none |
| output mode | `--output` → `NAMA_OUTPUT` → saved preference | `human` |

This precedence explains ambient behavior; reproducible operations do not rely on it. Agent and script operations always pass `--output json`. Server operations always pass `--profile <name>` and avoid an ambient profile, default profile, or server override. `profile set` names its profile and passes `--server`; `profile list` and `profile use` are local operations that ignore inherited profile and server selection.

JSON mode is the stable automation contract:

- Success: stdout contains exactly one JSON object followed by a newline, with the result under top-level `data`. Stderr is empty.
- Success may also contain top-level structured `warnings`; preserve and report every warning. Warnings do not move to stderr.
- Failure: stderr contains exactly one JSON object followed by a newline, with the failure under top-level `error`. Stdout is empty.
- JSON mode emits no prompts, progress, color, logs, or decorative output.
- Branch on process exit status and stable `error.code`, never on `error.message` or human prose. A positive retry delay, when present, is the unit-bearing `error.retry_delay` value.

Stable exit meanings:

| Exit | Meaning |
| ---: | --- |
| 0 | success |
| 1 | unexpected failure |
| 2 | invalid arguments or configuration |
| 3 | authentication failure |
| 4 | permission denied |
| 5 | resource not found |
| 6 | conflict |
| 7 | network or API unavailable |

## Inventory and mutate profiles

List profiles before every profile mutation and at the start of a server workflow:

```bash
"${nama_cmd[@]}" profile list --output json
```

Inspect `data.profiles[]`: `name`, canonical `server`, and `default` establish the current targets. Prefer a new profile name when the requested server differs from an existing profile's server.

Create a profile:

```bash
"${nama_cmd[@]}" profile set "$profile" --server "$server" --output json
"${nama_cmd[@]}" profile list --output json
```

Select a default only as a separate, explicit operation:

```bash
"${nama_cmd[@]}" profile use "$profile" --output json
"${nama_cmd[@]}" profile list --output json
```

The second list is mandatory read-after-write verification. Confirm the exact profile name, canonical server URL, and expected `default` value.

Repointing an existing profile to a different canonical server deletes that profile's stored bearer credential before saving the new target. Use a new profile unless the operator explicitly intends the retarget after this consequence is disclosed. If credential deletion fails, the CLI leaves the profile target unchanged; report the failure and stop. For any mutation or verification failure, follow [Handle ambiguity and retries](#handle-ambiguity-and-retries).

## Gate credential transport

HTTPS is the default. Nama accepts plain HTTP only for permitted loopback, private, link-local, localhost, or `.local` targets. Acceptance is not encryption: a bootstrap token, password, or bearer credential sent over plain HTTP is readable in transit.

Before any credential-bearing operation against a permitted plain-HTTP target:

1. Name the exact profile and URL.
2. State that the transport is unencrypted even on a private network.
3. Obtain explicit operator approval to send credentials to that target.

Approval to create or select a plain-HTTP profile alone is not approval to transmit credentials. Stop rather than bypassing the URL policy or silently accepting a warning.

After the operation, preserve and report every structured success warning, including `insecure_transport` when present.

## Keep secrets in approved channels

| Secret | Approved channel | Scope |
| --- | --- | --- |
| bootstrap token | `NAMA_BOOTSTRAP_TOKEN` in the setup process environment | non-interactive `setup` only |
| Administrator password | exactly one redirected stdin line | non-interactive `setup` or `auth login` |
| persistent bearer credential | CLI-managed native credential storage | selected server profile |
| process-local bearer credential | `NAMA_TOKEN` in the process environment | `auth status` only |
| human-entered secrets | the CLI's hidden terminal prompts in human mode | assisted setup or sign-in |

Supply environment secrets without placing their values in command text. Supply the password through an approved out-of-band stdin stream; never interpolate it into a shell command. Do not request secret values in chat or place them in arguments, profile configuration, output, logs, or copied command transcripts. Do not echo, invent, or persist them manually. If the execution environment cannot provide an approved channel, stop and identify that missing prerequisite.

JSON mode rejects terminal stdin for secret entry. A human-assisted hidden-prompt flow is separate: use an interactive terminal with human output, let the human type directly into the hidden prompt, and do not capture the input. Keep `NAMA_TOKEN` unset for setup and sign-in.

## Initialize the Administrator

Preconditions:

- the intended profile exists and matches the target observed by `profile list`;
- HTTPS is in use, or credential-bearing plain HTTP was explicitly approved;
- `NAMA_TOKEN` is unset;
- the bootstrap token and one-line password are available through their approved non-interactive channels; and
- root, `setup`, and relevant verification help came from the selected command prefix.

Run setup with only non-secret arguments:

```bash
"${nama_cmd[@]}" setup \
  --profile "$profile" \
  --display-name "$display_name" \
  --email "$email" \
  --output json
```

Provide `NAMA_BOOTSTRAP_TOKEN` in the process environment and the password as one stdin line without rendering either value. Successful `setup` checks setup state, creates the sole Administrator, signs in, and stores the resulting bearer credential in native credential storage. Do not run a second login after successful setup.

Verify independently with the same explicit profile:

```bash
"${nama_cmd[@]}" auth status --profile "$profile" --output json
```

Require exit 0, the expected profile and server in `data`, and `data.signed_in` equal to `true`. Preserve warnings. If verification fails, report the setup result and verification failure as uncertainty, then follow [Handle ambiguity and retries](#handle-ambiguity-and-retries).

Setup owns its lost-response reconciliation. Any setup failure, including exit 7, may follow a committed single-use mutation.

## Sign in later

Later sign-in is independent of fresh setup. Preconditions are the intended listed profile, the transport gate, `NAMA_TOKEN` unset, and one password line through approved stdin.

```bash
"${nama_cmd[@]}" auth login \
  --profile "$profile" \
  --email "$email" \
  --output json
"${nama_cmd[@]}" auth status --profile "$profile" --output json
```

The login stores the new bearer in native credential storage. The status call is mandatory read-after-write verification; require the same profile and server plus `data.signed_in` equal to `true`. Report a failed login or failed verification, then follow [Handle ambiguity and retries](#handle-ambiguity-and-retries).

## Read authentication status

Check the credential associated with the intended target explicitly:

```bash
"${nama_cmd[@]}" auth status --profile "$profile" --output json
```

For a one-process status check, `NAMA_TOKEN` may supply the bearer. It takes precedence over native credential lookup, is neither persisted nor deleted by the CLI, and has no stored expiry. Its approved scope is only `auth status`; setup and login fail closed while it is present. Apply the plain-HTTP approval gate before sending either an injected or stored bearer.

## Handle ambiguity and retries

Do not add a generic retry loop around CLI operations. Let the CLI perform its own bounded, operation-specific handling.

- Never blindly replay `setup`, `auth login`, `profile set`, `profile use`, or a future mutation after a transport failure, malformed response, timeout, or failed verification.
- Exit 7 means network or API unavailability; it does not prove that a mutation did not commit.
- Record the exact prefix, non-secret invocation, profile, target, exit status, stable error code, and structured warnings. Redact secret-bearing environment and stdin.
- Resolve uncertainty with the documented read-after-write command. If that read fails, report uncertainty and stop rather than mutating again.

## Confirm future destructive operations

Apply this policy only if a future runtime help tree exposes a destructive operation; do not infer a command path or confirmation syntax.

- A user request that explicitly names the destructive action and target is approval for that exact operation.
- If destruction is merely an inferred prerequisite, obtain approval naming the action and target before proceeding.
- Human interactive mode may present a confirmation prompt. JSON and other non-interactive modes never prompt; after approval, use only the confirmation flag shown by that command's runtime help.
- Never pipe unconditional affirmative input.
- Confirmation crosses only the prompt boundary. Authentication, authorization, validation, conflict handling, and server safeguards remain authoritative.
