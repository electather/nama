#!/usr/bin/env bash

set -eu
repo_dir="$(pwd -P)"
repo_parent="$(dirname "$repo_dir")"
generation_dir="$(mktemp -d "$repo_parent/.nama-contracts.XXXXXX")"
test -n "$generation_dir"
test -d "$generation_dir"
test ! -L "$generation_dir"
generation_dir="$(cd "$generation_dir" && pwd -P)"
test -n "$generation_dir"
test -d "$generation_dir"
test ! -L "$generation_dir"
test "$(dirname "$generation_dir")" = "$repo_parent"
case "$generation_dir" in
  "$repo_dir"|"$repo_dir"/*) exit 1 ;;
esac
for generated_leaf in gen/ts/src gen/go gen/swift/Sources/NamaAPI; do
  real_path="$repo_dir/$generated_leaf"
  case "$generation_dir" in
    "$real_path"|"$real_path"/*) exit 1 ;;
  esac
done
trap 'rm -rf -- "${generation_dir:?}"' EXIT

device_id() {
  if device_value="$(stat -f '%d' "$1" 2>/dev/null)"; then
    :
  elif device_value="$(stat -c '%d' "$1" 2>/dev/null)"; then
    :
  else
    return 1
  fi
  case "$device_value" in
    ''|*[!0-9]*) return 1 ;;
  esac
  printf '%s\n' "$device_value"
}

generation_device="$(device_id "$generation_dir")"
for publication_parent in "$repo_dir" "$repo_dir/gen" "$repo_dir/gen/ts" "$repo_dir/gen/swift/Sources"; do
  test -d "$publication_parent"
  test "$(device_id "$publication_parent")" = "$generation_device"
done

mkdir "$generation_dir/tmp"
test ! -L "$generation_dir/tmp"
test "$(cd "$generation_dir/tmp" && pwd -P)" = "$generation_dir/tmp"
TMPDIR="$generation_dir/tmp" buf format --diff --exit-code
TMPDIR="$generation_dir/tmp" buf lint
TMPDIR="$generation_dir/tmp" buf build
TMPDIR="$generation_dir/tmp" buf generate --template buf.gen.yaml --output "$generation_dir"
TMPDIR="$generation_dir/tmp" buf generate --template buf.gen.googleapis.yaml --output "$generation_dir"

for generated_leaf in gen/ts/src gen/go gen/swift/Sources/NamaAPI; do
  staged_path="$generation_dir/$generated_leaf"
  test -d "$staged_path"
  test ! -L "$staged_path"
  test "$(cd "$staged_path" && pwd -P)" = "$staged_path"
  test -d "$generated_leaf"
  test ! -L "$generated_leaf"
  test "$(cd "$generated_leaf" && pwd -P)" = "$repo_dir/$generated_leaf"
done

diff -ru gen/ts/src "$generation_dir/gen/ts/src"
diff -ru gen/go "$generation_dir/gen/go"
diff -ru gen/swift/Sources/NamaAPI "$generation_dir/gen/swift/Sources/NamaAPI"
