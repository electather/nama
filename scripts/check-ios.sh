#!/usr/bin/env bash

set -eu

project="apps/ios/Nama.xcodeproj"
scheme="Nama"
resolved="$project/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock_state="$(cksum "$resolved")"
entitlements="apps/ios/Nama/Resources/Nama.entitlements"
host_arch="$(uname -m)"
derived_data="$(mktemp -d)"

trap 'rm -rf "$derived_data"' EXIT

check_ats() {
  plist="$1"
  local_networking="$(plutil -extract NSAppTransportSecurity.NSAllowsLocalNetworking raw "$plist")"
  if test "$local_networking" != "true"; then
    echo "$plist does not enable ATS local networking" >&2
    return 1
  fi
  for forbidden_key in NSAllowsArbitraryLoads NSExceptionDomains
  do
    if plutil -type "NSAppTransportSecurity.$forbidden_key" "$plist" >/dev/null 2>&1; then
      echo "$plist contains forbidden ATS key $forbidden_key" >&2
      return 1
    fi
  done
}

swift format lint --strict --recursive apps/ios/Nama apps/ios/NamaTests

xcodebuild test -quiet \
  -project "$project" \
  -scheme "$scheme" \
  -destination "platform=macOS,arch=$host_arch" \
  -derivedDataPath "$derived_data" \
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
    -derivedDataPath "$derived_data" \
    CODE_SIGNING_ALLOWED=NO
done

for plist in \
  "$derived_data/Build/Products/Debug-iphoneos/Nama.app/Info.plist" \
  "$derived_data/Build/Products/Debug-appletvos/Nama.app/Info.plist" \
  "$derived_data/Build/Products/Debug/Nama.app/Contents/Info.plist"
do
  check_ats "$plist"
done

for entitlement in \
  'com\.apple\.security\.app-sandbox' \
  'com\.apple\.security\.network\.client' \
  'com\.apple\.security\.network\.server'
do
  value="$(plutil -extract "$entitlement" raw "$entitlements")"
  if test "$value" != "true"; then
    echo "$entitlements does not enable $entitlement" >&2
    exit 1
  fi
done

test "$lock_state" = "$(cksum "$resolved")"
