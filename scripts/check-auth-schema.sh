#!/bin/sh
set -eu

repository_root=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
server_directory="$repository_root/apps/server"
committed_schema="$server_directory/src/database/auth-schema.ts"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/nama-auth-schema.XXXXXX")
generated_schema="$temporary_directory/auth-schema.ts"

cleanup() {
  rm -rf "$temporary_directory"
}
trap cleanup 0
trap 'exit 1' 1 2 15

pnpm --dir "$server_directory" exec auth generate \
  --config "$server_directory/better-auth.config.ts" \
  --output "$generated_schema" \
  --adapter drizzle \
  --dialect postgresql \
  --yes >/dev/null

if [ ! -f "$committed_schema" ]; then
  printf 'Better Auth schema is missing: %s\n' "$committed_schema" >&2
  printf 'Regenerate it with: pnpm --filter @nama/server run generate:auth-schema\n' >&2
  exit 1
fi

if cmp -s "$committed_schema" "$generated_schema"; then
  exit 0
fi

printf 'Better Auth schema drift detected. Regenerate with: pnpm --filter @nama/server run generate:auth-schema\n' >&2
diff -u "$committed_schema" "$generated_schema" >&2 || true
exit 1
