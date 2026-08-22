#!/usr/bin/env bash

set -eu

project="apps/ios/Nama.xcodeproj"
scheme="Nama"
resolved="$project/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock_state="$(cksum "$resolved")"
host_arch="$(uname -m)"

swift format lint --strict --recursive apps/ios/Nama apps/ios/NamaTests

xcodebuild test -quiet \
  -project "$project" \
  -scheme "$scheme" \
  -destination "platform=macOS,arch=$host_arch" \
  CODE_SIGNING_ALLOWED=NO

for destination in \
  "generic/platform=iOS" \
  "generic/platform=tvOS" \
  "generic/platform=macOS"
do
  xcodebuild build -quiet \
    -project "$project" \
    -scheme "$scheme" \
    -destination "$destination" \
    CODE_SIGNING_ALLOWED=NO
done

test "$lock_state" = "$(cksum "$resolved")"
