#!/usr/bin/env bash

set -eu
repo_dir="$(pwd -P)"
repo_parent="$(dirname "$repo_dir")"
generation_dir="$(mktemp -d "$repo_parent/.nama-generate.XXXXXX")"
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

backup_root="$generation_dir/backups"
publish_complete=0
rollback_failed=0

restore_leaf() {
  generated_leaf="$1"
  real_path="$repo_dir/$generated_leaf"
  staged_path="$generation_dir/$generated_leaf"
  backup_path="$backup_root/$generated_leaf"

  if [ -d "$backup_path" ]; then
    if [ -d "$real_path" ] || [ -L "$real_path" ]; then
      if [ -d "$staged_path" ] || [ -L "$staged_path" ]; then
        rollback_failed=1
      elif ! mv "$real_path" "$staged_path"; then
        rollback_failed=1
      fi
    fi
    if [ ! -d "$real_path" ] && [ ! -L "$real_path" ]; then
      if ! mv "$backup_path" "$real_path"; then
        rollback_failed=1
      fi
    else
      rollback_failed=1
    fi
  fi
}

cleanup_generation() {
  exit_status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ "$publish_complete" -ne 1 ]; then
    restore_leaf gen/swift/Sources/NamaAPI
    restore_leaf gen/go
    restore_leaf gen/ts/src
    if [ "$rollback_failed" -ne 0 ]; then
      printf '%s\n' "generated-output rollback failed; recovery data preserved at $generation_dir" >&2
      exit 1
    fi
  fi
  rm -rf -- "${generation_dir:?}"
  exit "$exit_status"
}

trap cleanup_generation EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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

mkdir -p "$backup_root/gen/ts" "$backup_root/gen/swift/Sources"
test -d "$backup_root"
test ! -L "$backup_root"
test "$(cd "$backup_root" && pwd -P)" = "$backup_root"

for generated_leaf in gen/ts/src gen/go gen/swift/Sources/NamaAPI; do
  mv "$repo_dir/$generated_leaf" "$backup_root/$generated_leaf"
  mv "$generation_dir/$generated_leaf" "$repo_dir/$generated_leaf"
done
publish_complete=1
