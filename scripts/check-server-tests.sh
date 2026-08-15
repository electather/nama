#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/apps/server/test/compose.yaml"
project="nama-server-tests-${PPID}-$$"
compose=(docker compose --project-name "${project}" --file "${compose_file}")

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${compose[@]}" up --detach --wait
published_address="$("${compose[@]}" port postgres 5432)"
published_port="${published_address##*:}"
export NAMA_TEST_DATABASE_URL="postgres://nama:nama@127.0.0.1:${published_port}/nama"

pnpm --dir "${repository_root}" --filter @nama/server exec vitest run "$@"
