# Script guidance

- Scripts implement existing Mise tasks and run from the repository root. Keep task names and descriptions in `mise.toml`; do not add a second task dispatcher.
- Preserve generation staging, path and symlink checks, atomic publication, and rollback. Never generate directly into committed `gen/`.
- Check scripts must not mutate generated output or lockfiles. Use Bash with `set -eu`.
