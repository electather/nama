# Nama Player Lab operator record

This is the setup and evidence record for the Debug-only tvOS playback spike.
The fixture server is disposable, unauthenticated HTTP for a trusted LAN; stop it
after testing. Do not use real credentials. No physical-device run has been
performed for this record.

## Fixture setup

Supply media you are permitted to use. Do not commit it. The fixture root must
contain these exact paths:

| Path | Required profile | Provenance | SHA-256 | Duration |
| --- | --- | --- | --- | --- |
| `media/h264-sdr.mp4` | H.264 SDR, AAC stereo | UNRECORDED | UNRECORDED | UNRECORDED |
| `media/hevc-sdr.mp4` | HEVC SDR, AAC stereo | UNRECORDED | UNRECORDED | UNRECORDED |
| `media/hevc-hdr10.mp4` | HEVC HDR10, AAC stereo | UNRECORDED | UNRECORDED | UNRECORDED |
| `media/hevc-dolby-vision.mp4` | HEVC Dolby Vision, AAC stereo | UNRECORDED | UNRECORDED | UNRECORDED |
| `media/mkv-selectable-audio-text.mkv` | HEVC MKV, AAC stereo and 5.1, text subtitle | UNRECORDED | UNRECORDED | UNRECORDED |
| `subtitles/mkv-selectable-audio-text.en.srt` | English SubRip sidecar | UNRECORDED | UNRECORDED | UNRECORDED |
| `media/image-subtitles.mkv` | HEVC MKV with English image subtitle | UNRECORDED | UNRECORDED | UNRECORDED |

Record the source title/URL or generation recipe, applicable license, permitted
use, acquisition date, and any transformation in each Provenance field before a
run. Then run from the repository root, replacing only `fixture_root`:

```sh
fixture_root="/absolute/path/to/player-lab-fixtures"
test -d "$fixture_root"
find "$fixture_root" -type f -exec shasum -a 256 {} + | sort
python3 apps/tvos/fixture_server_check.py
lan_address="$(ipconfig getifaddr en0)"
test -n "$lan_address"
python3 apps/tvos/fixture_server.py --fixtures "$fixture_root" --bind "$lan_address" --port 8080
```

The server prints the primary origin on port `8080` and cross-origin target on
port `8081`. In the `Nama` scheme's Run arguments, add:

```text
--player-lab
--player-lab-base-url
http://<printed-primary-origin-host>:8080
```

Use the printed primary origin verbatim as the argument value. Keep the terminal
open while testing and press Control-C when finished.

## Manual checklist

Record exact values below before testing; do not write `latest`.

- Apple TV model/generation: UNRECORDED — UNVERIFIED
- tvOS version/build: UNRECORDED — UNVERIFIED
- display model: UNRECORDED — UNVERIFIED
- configured display mode: UNRECORDED — UNVERIFIED
- television-reported input mode for SDR/HDR10/Dolby Vision: UNRECORDED — UNVERIFIED
- audio route: UNRECORDED — UNVERIFIED (expected lab route: television speakers)

For each required row, perform two fresh player sessions. Each session must play
for at least five minutes or to the end of a shorter fixture, exercise
play/pause, one forward seek, one backward seek, post-seek recovery, and every
available audio/subtitle kind. Record engine-detected metadata, but verify HDR10
and Dolby Vision switching from the television's reported input mode. Confirm
multichannel content is intelligible through the television speakers. Record
only sanitized failures: no URLs, headers, credentials, or fixture-root paths.

## Playback results

Every row is currently unrun and therefore unverified.

| Fixture | Runs | Startup / sustained playback | Detected container / codec / range | Display-mode switch | Controls / seeks / recovery | Tracks / subtitle rendering | TV-speaker decode / downmix | Sanitized failure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `h264-sdr` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |
| `hevc-sdr` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |
| `hevc-hdr10` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |
| `hevc-dolby-vision` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |
| `mkv-selectable-audio-text` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |
| `image-subtitles` | 0/2 UNRUN | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | none recorded |

Atmos and surround passthrough are UNVERIFIED and do not block this spike. No
unsupported fixture has been supplied or run. Direct-stream/transcode fallback
is UNVERIFIED and remains deferred to the Jellyfin-negotiation spike.

## Redirect and dummy-credential observations

`GET /credential-check` returns and clears only
`{"dummy_credentials_received":true|false}`. It never returns the marker value.
Clear both origins before each row, play the fixture once, then query both again:

```sh
curl --fail --silent "http://<primary-host>:8080/credential-check"
curl --fail --silent "http://<primary-host>:8081/credential-check"
```

| Fixture | Expected primary | Expected secondary | Actual observation |
| --- | --- | --- | --- |
| `direct-dummy-credentials` | `true` | `false` | UNRUN — UNVERIFIED |
| `same-origin-redirect` | `true` | `false` | UNRUN — UNVERIFIED |
| `cross-origin-redirect` | `true` | `false`; any `true` is a blocker | UNRUN — UNVERIFIED |

AetherEngine `6.21.0` source strips known credentials, including
`Authorization` and `X-Emby-Token`, when an HTTP redirect changes port/origin.
It exposes no per-locator `allowed_redirect_origins` hook. Header containment is
mandatory; rejecting a credential-free redirect outside the advisory allowlist
is a known non-blocking gap for this pinned slice. Device evidence remains UNRUN.

## Dependency and distribution evidence

This is an engineering review, not legal advice. The application lock records:

| Package | Version | Exact revision |
| --- | --- | --- |
| AetherEngine | 6.21.0 | `87868c1c88ca4ae613180c4cfb5d68c07dde0298` |
| FFmpegBuild | 2.4.2 | `35f393fd588b7fa14452c3b4cc5d7c40e472c5e3` |
| LibDovi | 2.0.0 | `89be93431c2a5f2e54fb77e93059071b8d2ddb3a` |
| connect-swift | 1.2.3 | `ed56816fe90ab872566f09ed73e28ae078057e3d` |
| SMBClient | 0.3.1 | `e636c2b2458930770932a36d311ec9d478575b90` |
| swift-atomics | 1.3.1 | `0442cb5a3f98ab802acb777929fdb446bda11a34` |
| swift-collections | 1.6.0 | `a0cb0954ecb21e4e31b0070e6ed5674e8556685a` |
| swift-nio | 2.101.3 | `0b18836bd8b0162e7e17a995a3fbee20ed8f3b2b` |
| swift-nio-http2 | 1.45.0 | `45bdf670248be5f16ec0340e125dca285536f0fb` |
| swift-nio-ssl | 2.37.2 | `d930168b86f46ca51a4bc09c5ca45c1833db8067` |
| swift-protobuf | 1.38.1 | `55d7a1cc5666b85c13464aea1c4b4a90feccb4c8` |
| swift-system | 1.8.0 | `704705c5c51156ede21172a38654d522ce487074` |

The project selects the `AetherEngine` product, whose manifest selects
`FFmpegBuild` and `Dovi`; it does not select `AetherEngineSMB` or `SMBClient`.
SwiftPM still resolves packages needed by other products, so lock presence is
not proof that an artifact was linked. `NamaAPI` separately selects its
Connect/Protobuf dependencies. The final app linked graph and artifact inventory
are UNVERIFIED because pinned Xcode `26.6` and a built app were unavailable.

Locally inspected source evidence at the revisions above:

- AetherEngine's `LICENSE` is LGPL-3.0 with an Apple Store/DRM exception that
  retains corresponding-source obligations. Its package manifest is the product
  dependency evidence described above.
- FFmpegBuild's `Package.swift` umbrella product lists FFmpeg libraries, dav1d,
  zimg, and libzvbi. `LICENSES/README.md` identifies FFmpeg as
  LGPL-2.1-or-later, dav1d as BSD-2-Clause, zimg as WTFPL, and libzvbi as
  LGPL-2.0-or-later conveyed under LGPL-2.1 with an MIT file notice.
- FFmpegBuild's `build.sh` disables autodetection and does not enable GPL,
  nonfree, or version-3 FFmpeg components. It documents removing three GPL
  libzvbi source files and replacing referenced entry points with LGPL stubs.
  The checked-in tvOS-arm64 FFmpeg binaries also contain configuration strings
  without `--enable-gpl`, `--enable-nonfree`, or `--enable-version3`. This is
  binary metadata evidence, not reproducible provenance or proof of what a final
  Nama app linked.
- LibDovi's `LICENSE` licenses its packaging as MIT and identifies compiled
  libdovi/dovi_tool under the MIT option of MIT OR Apache-2.0.

Before adoption, Xcode `26.6` must produce the locked build and tests; the review
must retain the resolved product graph, build/link map, embedded frameworks,
architectures, and artifact hashes; and the actual FFmpeg binary configuration
must prove no GPL/nonfree components. A competent distribution review must then
settle notices, modification disclosures, Minimal Corresponding Source and
relinking/application-code obligations. The planned user-facing location is an
in-app Settings > Acknowledgements screen with durable release-specific source
and relinking materials; neither that UI nor release materials exist yet.

Distribution status: **BLOCKED / UNRESOLVED**. Do not claim GPL/nonfree clearance
or ship AetherEngine until the linked-artifact and obligation evidence closes.
