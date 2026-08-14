# Nama

Nama is a self-hosted media control plane. It keeps identity, configuration,
catalog state, and watch state in one core while provider plugins talk to
external media servers.

This repository is in its foundation milestones. The current baseline proves
the TypeScript, Go, Protobuf, and Docker boundaries. The disposable Apple TV
playback spike was retired after its decisions were recorded; no universal
iOS application is currently checked in.

## Prerequisites

- mise 2026.8.3 or newer
- Docker with Docker Compose

## Bootstrap

    mise install
    mise run setup
    mise run check

GitHub Actions runs the Linux checks and Protobuf compatibility gate. Generated
Swift bindings remain committed for the future universal app targeting iOS,
tvOS, and macOS, but are not a compiled application boundary.

## Architecture

- [System architecture](docs/architecture.md)
- [Repository and tooling](docs/architecture/repository-and-tooling.md)
- [Release plan](docs/release-plan.md)

## License

Nama is licensed under the GNU Affero General Public License version 3 only.
See [LICENSE](LICENSE).
