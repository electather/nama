#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${repository_root}/apps/ios/Nama.xcodeproj"
scheme="Nama"
resolved="${project}/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"
lock_state="$(cksum "${resolved}")"
entitlements="${repository_root}/apps/ios/Nama/Resources/Nama.entitlements"
host_arch="$(uname -m)"
work_directory="$(mktemp -d)"
derived_data="${work_directory}/derived-data"
compiler_log="${work_directory}/compiler.log"
result_bundle="${work_directory}/NamaTests.xcresult"
result_json="${work_directory}/xcode-tests.json"

trap 'rm -rf "${work_directory}"' EXIT INT TERM

run_xcodebuild() {
  xcodebuild "$@" >>"${compiler_log}" 2>&1
}

check_ats() {
  plist="$1"
  local_networking="$(plutil -extract NSAppTransportSecurity.NSAllowsLocalNetworking raw "${plist}")"
  if test "${local_networking}" != "true"; then
    printf '%s\n' "${plist} does not enable ATS local networking" >&2
    return 1
  fi
  for forbidden_key in NSAllowsArbitraryLoads NSExceptionDomains; do
    if plutil -type "NSAppTransportSecurity.${forbidden_key}" "${plist}" >/dev/null 2>&1; then
      printf '%s\n' "${plist} contains forbidden ATS key ${forbidden_key}" >&2
      return 1
    fi
  done
}

report_xcode_tests() {
  if test -z "${NAMA_TEST_HEALTH_REPORT:-}"; then
    return
  fi
  xcrun xcresulttool get test-results tests \
    --path "${result_bundle}" \
    --compact >"${result_json}"
  node "${repository_root}/scripts/test-health.mjs" \
    normalize-xcode "${result_json}" "${NAMA_TEST_HEALTH_REPORT}"
  node "${repository_root}/scripts/test-health.mjs" \
    summarize "${NAMA_TEST_HEALTH_REPORT}"
}

swift format lint --strict --recursive \
  "${repository_root}/apps/ios/Nama" \
  "${repository_root}/apps/ios/NamaTests"
swiftlint lint --strict

test_status=0
run_xcodebuild test \
  -project "${project}" \
  -scheme "${scheme}" \
  -destination "platform=macOS,arch=${host_arch}" \
  -derivedDataPath "${derived_data}" \
  -resultBundlePath "${result_bundle}" \
  CODE_SIGNING_ALLOWED=NO || test_status=$?
report_status=0
report_xcode_tests || report_status=$?
if (( test_status != 0 || report_status != 0 )); then
  cat "${compiler_log}"
  exit 1
fi

for destination in \
  "generic/platform=iOS" \
  "generic/platform=tvOS" \
  "generic/platform=macOS"
do
  if ! run_xcodebuild build \
    -project "${project}" \
    -scheme "${scheme}" \
    -destination "${destination}" \
    -derivedDataPath "${derived_data}" \
    CODE_SIGNING_ALLOWED=NO
  then
    cat "${compiler_log}"
    exit 1
  fi
done

for plist in \
  "${derived_data}/Build/Products/Debug-iphoneos/Nama.app/Info.plist" \
  "${derived_data}/Build/Products/Debug-appletvos/Nama.app/Info.plist" \
  "${derived_data}/Build/Products/Debug/Nama.app/Contents/Info.plist"
do
  check_ats "${plist}"
done

for entitlement in \
  'com\.apple\.security\.app-sandbox' \
  'com\.apple\.security\.network\.client' \
  'com\.apple\.security\.network\.server'
do
  value="$(plutil -extract "${entitlement}" raw "${entitlements}")"
  if test "${value}" != "true"; then
    printf '%s\n' "${entitlements} does not enable ${entitlement}" >&2
    exit 1
  fi
done

keychain_group="$(plutil -extract 'keychain-access-groups.0' raw "${entitlements}")"
if test "${keychain_group}" != '$(AppIdentifierPrefix)com.electather.nama'; then
  printf '%s\n' "${entitlements} does not use the app-scoped Keychain access group" >&2
  exit 1
fi

swiftlint analyze \
  --strict \
  --config "${repository_root}/.swiftlint-analyze.yml" \
  --compiler-log-path "${compiler_log}"
test "${lock_state}" = "$(cksum "${resolved}")"
