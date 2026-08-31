#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repository_root}/apps/server/integration/tests/compose.yaml"
project="nama-server-tests-${PPID}-$$"
compose=(docker compose --project-name "${project}" --file "${compose_file}")
export NAMA_TEST_JELLYFIN_COMPOSE_FILE="${compose_file}"
export NAMA_TEST_JELLYFIN_COMPOSE_PROJECT="${project}"
restart_mutating_test="integration/tests/jellyfin-real-provider.process.integration.test.ts"
main_tests=()
selects_restart_test=0
for test_path in "$@"; do
  case "${test_path}" in
    "${restart_mutating_test}")
      selects_restart_test=1
      ;;
    integration/tests/*.test.ts)
      main_tests+=("${test_path}")
      ;;
    *)
      printf '%s\n' "server test filters must be exact integration test paths" >&2
      exit 64
      ;;
  esac
done


cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${repository_root}/scripts/check-jellyfin-extension.sh"

"${compose[@]}" up --detach --wait postgres
published_address="$("${compose[@]}" port postgres 5432)"
published_port="${published_address##*:}"
export NAMA_TEST_DATABASE_URL="postgres://nama:nama@127.0.0.1:${published_port}/nama"
unset NAMA_TEST_JELLYFIN_URL
if "${compose[@]}" up --detach --wait jellyfin; then
  jellyfin_published_address="$("${compose[@]}" port jellyfin 8096)"
  jellyfin_published_port="${jellyfin_published_address##*:}"
  export NAMA_TEST_JELLYFIN_URL="http://127.0.0.1:${jellyfin_published_port}/"
else
  printf '%s\n' "Jellyfin unavailable; real-provider proof will be reported as skipped" >&2
fi

vitest=(pnpm --dir "${repository_root}" --filter @nama/server exec vitest run)
if (( $# == 0 )); then
  "${vitest[@]}" --exclude "${restart_mutating_test}"
  "${vitest[@]}" "${restart_mutating_test}"
else
  if (( ${#main_tests[@]} > 0 )); then
    "${vitest[@]}" --exclude "${restart_mutating_test}" "${main_tests[@]}"
  fi
  if (( selects_restart_test == 1 )); then
    "${vitest[@]}" "${restart_mutating_test}"
  fi
fi
