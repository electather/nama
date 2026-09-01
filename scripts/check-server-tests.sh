#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if test -n "${NAMA_TEST_HEALTH_REPORT:-}"; then
  case "${NAMA_TEST_HEALTH_REPORT}" in
    /*) ;;
    *) export NAMA_TEST_HEALTH_REPORT="${repository_root}/${NAMA_TEST_HEALTH_REPORT}" ;;
  esac
fi
compose_file="${repository_root}/apps/server/integration/tests/compose.yaml"
project="nama-server-tests-${PPID}-$$"
compose=(docker compose --project-name "${project}" --file "${compose_file}")
export NAMA_TEST_JELLYFIN_COMPOSE_FILE="${compose_file}"
export NAMA_TEST_JELLYFIN_COMPOSE_PROJECT="${project}"
export NAMA_TEST_RUN_ID="${NAMA_TEST_RUN_ID:-${project}}"
selected_tests=()
for test_path in "$@"; do
  case "${test_path}" in
    integration/tests/*.test.ts)
      selected_tests+=("${test_path}")
      ;;
    *)
      printf '%s\n' "server test filters must be exact integration test paths" >&2
      exit 64
      ;;
  esac
done


cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  if test -n "${resource_file:-}"; then
    rm -f "${resource_file}"
  fi
}
trap cleanup EXIT INT TERM

if test "${NAMA_TEST_EXTENSION_READY:-0}" != "1"; then
  "${repository_root}/scripts/check-jellyfin-extension.sh"
fi

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

vitest=(
  pnpm --dir "${repository_root}" --filter @nama/server exec vitest run
  --project parallel
  --project shared-jellyfin
)
if test -n "${NAMA_TEST_HEALTH_REPORT:-}"; then
  resource_file="$(mktemp)"
  status=0
  node "${repository_root}/scripts/run-with-resources.mjs" \
    "${resource_file}" "vitest worker pool" \
    "${vitest[@]}" "${selected_tests[@]}" || status=$?
  if test -f "${NAMA_TEST_HEALTH_REPORT}"; then
    node "${repository_root}/scripts/test-health.mjs" \
      add-resource "${NAMA_TEST_HEALTH_REPORT}" "${resource_file}"
    node "${repository_root}/scripts/test-health.mjs" \
      summarize "${NAMA_TEST_HEALTH_REPORT}"
  fi
  exit "${status}"
fi
"${vitest[@]}" "${selected_tests[@]}"
