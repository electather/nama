#!/usr/bin/env bash

set -eu
python3 apps/tvos/fixture_server_check.py
export DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer
lock_state="$(cksum apps/tvos/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved)"
swift format lint --strict --recursive apps/tvos gen/swift/Package.swift
xcodebuild -project apps/tvos/Nama.xcodeproj -scheme Nama -destination 'generic/platform=tvOS Simulator' -derivedDataPath .derived-data -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile CODE_SIGNING_ALLOWED=NO build
xcodebuild -project apps/tvos/Nama.xcodeproj -scheme Nama -destination 'platform=tvOS Simulator,name=Apple TV,OS=latest' -derivedDataPath .derived-data -disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile CODE_SIGNING_ALLOWED=NO test
test "$lock_state" = "$(cksum apps/tvos/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved)"
