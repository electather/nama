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

`mise run setup` resolves locked dependencies and installs the repository's
pre-commit hook. The hook gates changed server quality; `mise run check` remains
the complete repository verification command.

GitHub Actions runs the Linux checks and Protobuf compatibility gate. Generated
Swift bindings remain committed for the future universal app targeting iOS,
tvOS, and macOS, but are not a compiled application boundary.

## Container quick start

The supported local artifact is `nama:local`: one unprivileged application
image containing the core and bundled Jellyfin executable. PostgreSQL is the
only separate service. The Go CLI remains an external client.

Create operator-owned configuration and secrets:

```bash
umask 077
mkdir -p secrets
node --input-type=module --eval \
  'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));' \
  > secrets/postgres_password
cp nama.example.toml nama.toml
node --input-type=module --eval \
  'import { randomBytes } from "node:crypto"; process.stdout.write(`base64:${randomBytes(32).toString("base64")}\n`);'
```

Replace both placeholders in `nama.toml`. Copy the generated master key into
`security.master_key`. Copy the database password from
`secrets/postgres_password` into `database.url` unchanged; its base64url form is
safe in the URL. Set `server.public_url` to the URL clients will use. Then make
the file readable by Nama's fixed group without exposing it to other host
users:

```bash
sudo chown "$(id -u):10001" nama.toml
chmod 0640 nama.toml
chmod 0600 secrets/postgres_password
```

The application mount is read-only, so UID/GID `10001:10001` can read but
cannot change the operator-owned configuration.

Build and start the canonical two-service model:

```bash
docker compose up --build --detach --wait
curl --fail http://127.0.0.1:8080/health/ready
go build -o bin/nama ./apps/cli/cmd/nama
bin/nama profile set local --server http://127.0.0.1:8080
bin/nama setup --profile local --display-name "Nama Administrator" --email you@example.com
```

Read the one-time bootstrap token from `docker compose logs nama` and enter it
only at the CLI prompt. The CLI also prompts for the Administrator password
without echoing it. A later session uses `bin/nama auth login --profile local`.

Configure an existing Jellyfin deployment without calling private RPCs:

```bash
umask 077
cat > jellyfin.json <<'EOF'
{"api_key":"REPLACE_WITH_JELLYFIN_API_KEY","base_url":"http://jellyfin.example.local:8096","user_id":"REPLACE_WITH_JELLYFIN_USER_ID"}
EOF
bin/nama provider type test jellyfin --configuration jellyfin.json --profile local
bin/nama provider instance create jellyfin \
  --display-name "Home Jellyfin" \
  --configuration jellyfin.json \
  --profile local
rm jellyfin.json
```

Nama is published on host loopback only. Deliberate LAN or VPN exposure sets an
explicit host address, for example
`NAMA_HOST_BIND=192.168.1.10 docker compose up --detach`; update
`server.public_url` to match. PostgreSQL has no production host port. Developers
can publish it on loopback with
`docker compose -f compose.yaml -f compose.development.yaml up --detach`.
Configuration is mounted read-only, plugin sockets live only in a private
ephemeral runtime mount, and `docker compose down` preserves PostgreSQL data
unless `--volumes` is explicitly supplied. Image publication, signing,
provenance, and release versioning remain deferred.

## Architecture

- [System architecture](docs/architecture.md)
- [Repository and tooling](docs/architecture/repository-and-tooling.md)
- [Release plan](docs/release-plan.md)

## License

Nama is licensed under the GNU Affero General Public License version 3 only.
See [LICENSE](LICENSE).
