# AetherEngine 6.21.0 distribution record

Status: the source, dependency closure, local Release linkage, bundled notices, corresponding-source locations, and relinking obligations are recorded. The reviewed local candidate is not a distributable artifact because code signing was disabled. Every final iOS, tvOS, and macOS archive remains blocked until its release signature and final artifact checksums are appended to this record.

## Dependency lock

The application target requires AetherEngine with Xcode's `exactVersion` requirement at `6.21.0`. `apps/ios/Nama.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` pins the complete package graph below and has SHA-256 `3972fa972b67d60a503b5a2ceb4b0dbc3089e6dce308ecc410e2ab4c88a777d6`. `scripts/check-ios.sh` snapshots that file before its builds and fails if dependency resolution changes it.

| Package | Version | Git commit checksum |
| --- | --- | --- |
| AetherEngine | 6.21.0 | `87868c1c88ca4ae613180c4cfb5d68c07dde0298` |
| Connect Swift | 1.2.3 | `ed56816fe90ab872566f09ed73e28ae078057e3d` |
| FFmpegBuild | 2.4.3 | `b2185fa842b829cd53d182a5e9a53182c1d9c84c` |
| LibDovi | 2.0.0 | `89be93431c2a5f2e54fb77e93059071b8d2ddb3a` |
| SMBClient | 0.3.1 | `e636c2b2458930770932a36d311ec9d478575b90` |
| swift-atomics | 1.3.1 | `0442cb5a3f98ab802acb777929fdb446bda11a34` |
| swift-collections | 1.6.0 | `a0cb0954ecb21e4e31b0070e6ed5674e8556685a` |
| swift-nio | 2.101.3 | `0b18836bd8b0162e7e17a995a3fbee20ed8f3b2b` |
| swift-nio-http2 | 1.45.0 | `45bdf670248be5f16ec0340e125dca285536f0fb` |
| swift-nio-ssl | 2.37.2 | `d930168b86f46ca51a4bc09c5ca45c1833db8067` |
| SwiftProtobuf | 1.38.1 | `55d7a1cc5666b85c13464aea1c4b4a90feccb4c8` |
| swift-system | 1.8.1 | `869129b7bf4ecc57b97d0193ad29690ca2134750` |

SMBClient is resolved because it is a package-level AetherEngine dependency. Nama links only the `AetherEngine` product, not `AetherEngineSMB`, so SMBClient is absent from the built target and artifacts.

### Bundled native source closure

The prebuilt native libraries in FFmpegBuild and LibDovi resolve their build-script tags to the immutable upstream commits and reviewed source archives below. The source-archive SHA-256 values were computed from the exact commit archive URLs, not mutable tag archives.

| Bundled source | Build-script tag | Immutable upstream commit | Source archive SHA-256 |
| --- | --- | --- | --- |
| FFmpeg | `n8.1.2` | [`38b88335f99e76ed89ff3c93f877fdefce736c13`](https://github.com/FFmpeg/FFmpeg/tree/38b88335f99e76ed89ff3c93f877fdefce736c13) | `2ae7e42343cfffb811d15cfe98b6d005f082595fcdf034d30a4ff90cfed9f9c6` |
| dav1d | `1.5.1` | [`42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa`](https://code.videolan.org/videolan/dav1d/-/tree/42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa) | `e26d41e2f496c1598f418726b871ce252ce9f18f8dbe3ad199349a42ed2cb02f` |
| zimg | `release-3.0.5` | [`e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87`](https://github.com/sekrit-twc/zimg/tree/e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87) | `3ab062eff30067799997bc3e911c0108a5b8cbcd6e0ef14053f17ff0ecd0add8` |
| libzvbi | `v0.2.44` | [`5169a428d51c3ae8ff7b0897e8a687d8e05e37b5`](https://github.com/zapping-vbi/zvbi/tree/5169a428d51c3ae8ff7b0897e8a687d8e05e37b5) | `f503d37ddaff9172919e17ee32f4d66cc488f47218cf3961bf1c81055e0455e8` |
| dovi_tool / `dolby_vision` | `libdovi-3.3.2` | [`4fd2b2235c9f93582dd4a00e65ee34a07800afd7`](https://github.com/quietvoid/dovi_tool/tree/4fd2b2235c9f93582dd4a00e65ee34a07800afd7) | `bfbd324c867586968fd9b5df2ee7977acb11097bc098b2a8e261d68b8f3f52d0` |

FFmpegBuild's exact wrapper commit `b2185fa842b829cd53d182a5e9a53182c1d9c84c` owns the applied FFmpeg and libzvbi source patches and the complete Apple build configuration. LibDovi's exact wrapper commit `89be93431c2a5f2e54fb77e93059071b8d2ddb3a` owns its Apple build configuration. The dovi_tool [`Cargo.lock`](https://github.com/quietvoid/dovi_tool/blob/4fd2b2235c9f93582dd4a00e65ee34a07800afd7/Cargo.lock) at that commit pins the complete Rust crate closure and has SHA-256 `ed6d086945a25a6c52aa78104ed460875801c94dbc7c897f702057e4a6f0604e`.

These commit IDs, archive checksums, wrapper commits, and the Cargo lock—not the mutable tag names in the wrapper build scripts—are the reviewed source inputs. A final distribution must retain these exact source archives alongside the wrapper build scripts; a changed source byte, patch, or Cargo lock blocks release and requires a fresh binary and linkage review.

## Reviewed build and linkage

The local linkage review used Xcode 26.6 build `17F113`, the repository's Release configuration, and `generic/platform=macOS`. It produced a universal arm64/x86_64 executable. AetherEngine Swift code and LibDovi are linked into the Nama executable. They do not appear as dynamic load commands or separately bundled frameworks.

FFmpegBuild remains nine separately embedded, replaceable dynamic frameworks. The Nama executable loads each through `@rpath`; no mergeable-library or static FFmpeg configuration is enabled:

- `Libavcodec.framework`
- `Libavformat.framework`
- `Libavutil.framework`
- `Libswresample.framework`
- `Libswscale.framework`
- `Libavfilter.framework`
- `Libdav1d.framework`
- `Libzimg.framework`
- `Libzvbi.framework`

The reviewed binaries had these SHA-256 checksums before application signing:

| Binary | SHA-256 |
| --- | --- |
| `Nama` | `b14f49334d68c855b1004fb3d40d681fb18d74c5fef761b56136e59bab4bf683` |
| `Libavcodec` | `acf44532ccf0dccad6313d472f9489288e2939112e3c3b8d9694e121409ef2f2` |
| `Libavfilter` | `6b8bc901f1faf4776a022c28e43f2b3e5cd217c734af127e9ee843551f28a1f7` |
| `Libavformat` | `fdacd934339235ef7ccf67bc24d2a45abfe97ac3ddf39c42196c45a3b66e5af1` |
| `Libavutil` | `232da19ed52fdfcfb36d3b353eb6a2b515ba899ef65a7e7ca5ebc719ac07790c` |
| `Libdav1d` | `e07d4a8a4470ab902b4d6f88b694a4d54518359b22f1455a60c78db28f13fa3d` |
| `Libswresample` | `38c4adddbbca9db169cb066d802cca932111fd3018b25957d5d6908385ec0949` |
| `Libswscale` | `a9cc64be5969abaf3a33053272414bd68d37e3bb1d14401bdb244d487181ad27` |
| `Libzimg` | `661a3b9f64a22ad59b057cd6c0a05980453c428045f060d5fe2bf82c850c5d21` |
| `Libzvbi` | `06bfcd9f3637f61b12dae0e111de81be586d1489d6aee8f228fd3e33e4824692` |

The reviewed app used `CODE_SIGNING_ALLOWED=NO`; `codesign --verify --deep --strict` correctly reported that the app was not signed. The embedded prebuilt FFmpeg frameworks retained ad hoc signatures only. These values prove local build composition, not distributable provenance.

Before distributing any archive, record its platform, archive/export configuration, Xcode build, final app or IPA/PKG SHA-256, application and framework CDHashes, signing identity and Team identifier, entitlements, notarization result where applicable, and the same dynamic-framework inventory. A missing or changed row blocks distribution.

## Licenses, notices, and corresponding source

The application bundles `Nama/Resources/Licenses` with:

- AetherEngine's LGPL-3 text and Apple Store / DRM Exception;
- the GPL-3 text incorporated by LGPL-3;
- FFmpegBuild's LGPL-2.1 text;
- dav1d's BSD-2-Clause text;
- zimg's WTFPL text;
- LibDovi's MIT notice, including its libdovi notice;
- libzvbi's `ure.c` MIT notice; and
- `ThirdPartyNotices.txt`, which identifies the components, exact source revisions, and relinking terms.

Corresponding source is defined by the exact wrapper repositories and commits in the dependency table plus the immutable upstream commits, archive checksums, and Cargo lock above. Nama's corresponding application source and Xcode build configuration are in this repository. A modified dependency must point to the exact distributing fork and revision instead of the upstream link.

AetherEngine is LGPL-3 with its Section 7 Apple Store / DRM Exception. The exception permits App Store, TestFlight, signing, DRM, and store restrictions that would otherwise conflict with installation, redistribution, or relinking rights. It does not waive corresponding-source, notice, study, modification, or non-store distribution obligations.

FFmpegBuild 2.4.3 uses dynamic frameworks specifically to preserve LGPL replacement and relinking. Distribution must keep those frameworks separate, keep `@rpath` linkage, reproduce the bundled licenses and notices, and provide the exact corresponding source. Merging the frameworks into the Nama executable or switching to FFmpegBuild's static variant is prohibited without a new license review and a compliant object-file or source relinking offer.

FFmpegBuild records FFmpeg and its packaging as LGPL-2.1-or-later, dav1d as BSD-2-Clause, zimg as WTFPL, and the included libzvbi library sources as LGPL-2.0-or-later with the `ure.c` MIT notice. Its build disables GPL and LGPL-v3 FFmpeg components and excludes libzvbi's GPL source files. LibDovi is consumed under its MIT option.

## Accepted MVP security limits

ADR-0032's two exceptions remain exact: AetherEngine may write complete short-lived Locator URLs to its local Release logs and may replay Locator headers when a request moves between origins already present in the core-validated allowlist. The review does not permit another origin, a reusable credential, Nama-owned Locator logging or persistence, uploaded engine logs, or Locator-bearing product failures.

The production adapter contains both package limitations behind its session-scoped loopback bridge: AetherEngine receives opaque loopback locators and no upstream Locator headers. ADR-0032 remains the dependency eligibility ceiling; bypassing that bridge or restoring direct upstream engine access requires a new security review.
