#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
raw_events=""
resource_file=""
cleanup() {
  if test -n "${raw_events}"; then
    rm -f "${raw_events}"
  fi
  if test -n "${resource_file}"; then
    rm -f "${resource_file}"
  fi
}
trap cleanup EXIT INT TERM

unformatted="$(gofmt -l apps/cli gen/go)"
if [ -n "$unformatted" ]; then
  printf '%s\n' "$unformatted"
  exit 1
fi
lock_state="$(cksum go.mod go.sum)"
go vet ./...
staticcheck ./apps/cli/...

shuffle=()
if test -n "${NAMA_TEST_SHUFFLE_SEED:-}"; then
  if ! [[ "${NAMA_TEST_SHUFFLE_SEED}" =~ ^-?[0-9]+$ ]]; then
    printf '%s\n' "NAMA_TEST_SHUFFLE_SEED must be an integer" >&2
    exit 64
  fi
  shuffle=("-shuffle=${NAMA_TEST_SHUFFLE_SEED}")
fi

status=0
if test -n "${NAMA_TEST_HEALTH_REPORT:-}"; then
  raw_events="$(mktemp)"
  resource_file="$(mktemp)"
  node "${repository_root}/scripts/run-with-resources.mjs" \
    "${resource_file}" "go test process" \
    go test -json "${shuffle[@]}" ./... >"${raw_events}" || status=$?
  if (( status != 0 )); then
    cat "${raw_events}"
  fi
  node "${repository_root}/scripts/test-health.mjs" \
    normalize-go "${raw_events}" "${NAMA_TEST_HEALTH_REPORT}"
  node "${repository_root}/scripts/test-health.mjs" \
    add-resource "${NAMA_TEST_HEALTH_REPORT}" "${resource_file}"
  node "${repository_root}/scripts/test-health.mjs" \
    summarize "${NAMA_TEST_HEALTH_REPORT}"
else
  go test "${shuffle[@]}" ./... || status=$?
fi
test "$lock_state" = "$(cksum go.mod go.sum)"
exit "${status}"
