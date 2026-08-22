#!/usr/bin/env bash

set -eu

project="apps/ios/Nama.xcodeproj"
scheme="Nama"
host_arch="$(uname -m)"
derived_data="$(mktemp -d)"
compiler_log="$(mktemp)"

trap 'rm -rf "$derived_data" "$compiler_log"' EXIT

run_xcodebuild() {
  if ! xcodebuild "$@" >>"$compiler_log" 2>&1; then
    cat "$compiler_log"
    return 1
  fi
}

swiftlint lint --strict

run_xcodebuild test \
  -project "$project" \
  -scheme "$scheme" \
  -destination "platform=macOS,arch=$host_arch" \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO

for destination in \
  "generic/platform=iOS" \
  "generic/platform=tvOS"
do
  run_xcodebuild build \
    -project "$project" \
    -scheme "$scheme" \
    -destination "$destination" \
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO
done

swiftlint analyze --strict --config .swiftlint-analyze.yml --compiler-log-path "$compiler_log"
