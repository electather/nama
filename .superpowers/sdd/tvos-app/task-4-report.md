# Task 4 report — LAN fixture harness and verification gates

## Status

Implemented and locally verified to the limits of this host. Physical Apple TV,
display-mode, final linked-artifact, and Xcode `26.6` gates remain explicitly
unverified. Distribution adoption remains blocked pending those gates. The Task
3 raw-backslash JSON-test minor remains deferred and was not changed.

## Implementation and files

- `apps/tvos/fixture_server.py`: dependency-free dual-origin fixture server;
  explicit root/bind/primary port; GET/HEAD; single ranges; deterministic
  same/cross redirects; resolved-root and symlink containment; redacted,
  consume-on-read credential-marker status. No TLS, auth, uploads, directory
  listing, admin surface, framework, or media.
- `apps/tvos/fixture_server_check.py`: one standard-library temporary-fixture
  check for complete GET/HEAD, prefix/suffix/HEAD ranges, malformed,
  unsatisfiable and multi-ranges, traversal/symlink containment, both redirects,
  direct marker observation, cross-origin stripping, and marker redaction.
- `apps/tvos/PLAYER_LAB.md`: exact operator setup, fixture paths and blank
  provenance/hash fields, Xcode arguments, checklist/matrix, redirect evidence,
  hardware unknowns, exact pins, inspected licenses/configuration, and blocked
  distribution obligations.
- `docs/architecture/api-contracts.md`: scoped AetherEngine `6.21.0` allowlist
  exception; origin-change credential stripping remains mandatory.
- `mise.toml`, `.github/workflows/ci.yml`: preserve strict format, generic
  unsigned simulator build, locked resolution and lock-drift check; add native
  tests using `platform=tvOS Simulator,name=Apple TV,OS=latest`.
- Xcode project, scheme, resources, plist, manifest, and lock were inspected and
  consistent; no integration edit was necessary.

## TDD RED / GREEN

RED:

```text
$ python3 apps/tvos/fixture_server_check.py
ModuleNotFoundError: No module named 'fixture_server'
exit 1
```

First GREEN attempts found and corrected two real check defects: use of nonexistent
`urllib.request.open`, then case-sensitive redirected-header removal. Final:

```text
$ python3 apps/tvos/fixture_server_check.py
fixture server self-check: OK
exit 0
```

The loopback command required sandbox escalation. It used only temporary files
and ephemeral `127.0.0.1` ports. Context-manager shutdown joined both server
threads; no repository artifacts remained (`apps/tvos/__pycache__` absent).

## Source and dependency evidence

The application lock and local exact checkouts agree:

- AetherEngine `6.21.0` / `87868c1c88ca4ae613180c4cfb5d68c07dde0298`
- FFmpegBuild `2.4.2` / `35f393fd588b7fa14452c3b4cc5d7c40e472c5e3`
- LibDovi `2.0.0` / `89be93431c2a5f2e54fb77e93059071b8d2ddb3a`

AetherEngine's selected product depends on FFmpegBuild and Dovi, not
AetherEngineSMB/SMBClient. Its license is LGPL-3.0 plus its Apple Store/DRM
exception. FFmpegBuild inventories FFmpeg LGPL-2.1-or-later, dav1d BSD-2-Clause,
zimg WTFPL, and libzvbi LGPL/MIT evidence; build flags omit GPL/nonfree/version3,
and checked-in tvOS-arm64 FFmpeg configuration strings likewise contain no such
enable flags. LibDovi packaging is MIT and records libdovi under its MIT option.
This is an engineering review, not legal advice.

## Verification evidence

Passed:

```text
python3 apps/tvos/fixture_server_check.py
swift format lint --strict --recursive apps/tvos
swiftc -frontend -parse <all apps/tvos Swift files>
Python AST + mise TOML parse
workflow YAML parse
plutil: Debug-Info.plist and project.pbxproj
xmllint: scheme and workspace XML
jq: manifest and Package.resolved JSON
project/scheme/pin/manifest consistency assertions
git diff --check
no committed media, private-address literals, credential-shaped values,
fixture bytecode/cache, or fixture-root artifacts
```

The full existing format command was also run and failed only on pre-existing
`gen/swift/Package.swift:31` trailing-comma lint (unchanged since before this
phase). Focused `apps/tvos` strict formatting passed.

## Self-review

- Security boundaries resolve the root and candidate strictly and verify
  `relative_to(root)` after symlink resolution. Unsafe/missing paths share an
  empty `404`; invalid and multi-ranges share an empty `416` with total size.
- The server never logs request lines or headers. Status contains one boolean,
  clears after read, and the check asserts neither dummy value appears.
- Routes exactly match the committed manifest: `redirect/same/...` and
  `redirect/cross/...`. The one process-wide marker flag is sufficient for the
  single-operator lab; request correlation is deliberately absent.
- No Protobuf or generated files changed. Public/provider-neutral boundaries
  remain intact. The Task 3 deferred test was not silently claimed fixed.

## Exact unverified gates and blockers

`mise run check:swift` was attempted and failed before format/build/test:

```text
xcrun: error: missing DEVELOPER_DIR path:
/Applications/Xcode_26.6.app/Contents/Developer
```

Therefore package resolution, generic simulator build, native simulator tests,
physical-device build/playback, two-run fixture matrix, direct/same/cross device
redirect observations, HDR10/Dolby Vision television mode switching, track and
subtitle behavior, seeking, and TV-speaker decode/downmix are UNVERIFIED. Atmos
and passthrough remain intentionally unverified.

No Xcode linked app exists, so the resolved product graph, actual app link map,
embedded artifacts, binary hashes/architectures, final GPL/nonfree status,
notices, modification disclosures, corresponding-source/relinking materials,
and competent legal review are UNVERIFIED. These unresolved obligations block
AetherEngine distribution adoption; no result was fabricated.

## Fix Round 1

Addressed all Important review findings without adding dependencies or server
features.

### TDD RED / GREEN

The expanded real-HTTP self-check installed a deterministic hook at the old
path-open boundary: after validation, `media/race.bin` was replaced by an
outside-root symlink. RED proved the race was exploitable:

```text
$ python3 apps/tvos/fixture_server_check.py
AssertionError: a component swapped to a symlink was served
exit 1
```

Production now opens the fixture root once, opens every directory and final
file component relative to that descriptor with `O_NOFOLLOW` (and
`O_DIRECTORY` for intermediate components), verifies the opened descriptor is
a regular file, and uses that same descriptor for `fstat`, ranges, and response
bytes. GREEN:

```text
$ python3 apps/tvos/fixture_server_check.py
fixture server self-check: OK
exit 0
```

The same check now independently asserts:

- full and HEAD responses; `bytes=2-5`, suffix `bytes=-3`, open-ended
  `bytes=6-`, explicit `bytes=0-3`, and ranged HEAD;
- malformed, reversed, unsatisfiable, and multi-range `416` results;
- zero-byte full response and zero-byte range `416` with `bytes */0`;
- direct, single-encoded, double-encoded, encoded-separator, encoded-backslash,
  final symlink, and symlinked-intermediate containment;
- deterministic swap of the final component to an outside symlink is refused;
- raw same-origin and cross-origin `307`, exact `Location`, empty body, then
  followed redirect behavior;
- primary marker receipt during cross-origin redirect, secondary non-receipt
  after stripping, and marker-value redaction.

Credential state is now one lock-protected boolean. Marker arrival and
consume-and-clear each occur under that lock, so status cannot lose an arrival
between separate `is_set()` and `clear()` operations. Only the boolean is
returned.

The single blocking Swift format defect was corrected in
`gen/swift/Package.swift`; the strict full-root command now passes:

```text
$ swift format lint --strict --recursive apps/tvos gen/swift/Package.swift
exit 0
```

Pinned Xcode `26.6`, simulator/device, playback, linked-artifact, and legal
obligation gates remain exactly as unverified above. `mise run check:swift`
was attempted again after the strict format fix and still stopped at the same
missing `DEVELOPER_DIR` path before build or tests.
