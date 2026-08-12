#!/usr/bin/env bash

set -eu
unformatted="$(gofmt -l apps/cli gen/go)"
if [ -n "$unformatted" ]; then
  printf '%s\n' "$unformatted"
  exit 1
fi
lock_state="$(cksum go.mod go.sum)"
go vet ./...
go test ./...
test "$lock_state" = "$(cksum go.mod go.sum)"
