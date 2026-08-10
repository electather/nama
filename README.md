# Nama

Nama is a self-hosted media control plane. It keeps identity, configuration,
catalog state, and watch state in one core while provider plugins talk to
external media servers.

This repository is in its foundation milestones; the current baseline proves
the TypeScript, Go, Swift/tvOS, Protobuf, and Docker boundaries without adding
product behavior.

## Prerequisites

- mise 2026.8.3 or newer
- Docker with Docker Compose
- macOS with Xcode 26.6 for the tvOS build

## Bootstrap

    mise install
    mise run setup
    mise run check

GitHub Actions runs the Linux checks and the authoritative tvOS simulator
build. A machine without full Xcode can run the contract, TypeScript, Go, and
Docker checks individually.

## Architecture

- [System architecture](docs/architecture.md)
- [Repository and tooling](docs/architecture/repository-and-tooling.md)
- [Release plan](docs/release-plan.md)

## License

Nama is licensed under the GNU Affero General Public License version 3 only.
See [LICENSE](LICENSE).
