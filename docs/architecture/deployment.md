# Deployment and exposure

Status: the locally buildable Linux application image and canonical Compose
deployment are implemented and exercised. Publication as a release artifact
remains deferred.

[ADR-0016](../adr/0016-linux-application-image-and-postgresql.md) is implemented
as `nama:local`, built from exact `node:24.19.0-bookworm-slim` stages without an
architecture override or TypeScript compilation pipeline. The final image
contains narrowly selected core sources, reviewed migrations, generated
TypeScript contracts, production dependencies, and the bundled Jellyfin
executable. Node directly owns PID 1. The Go CLI remains external, and
PostgreSQL 18 is the only separate service.

The canonical `compose.yaml` waits for healthy PostgreSQL, publishes only the
core on host loopback by default, and checks exact `GET /health/ready`.
PostgreSQL reads its password from an operator-owned Compose secret and has no
production host port. `compose.development.yaml` adds only PostgreSQL's
loopback port. Operators may deliberately change the core host bind without
changing the image.

The application runs as fixed UID/GID `10001`, drops every capability, enables
`no-new-privileges`, and uses a read-only root filesystem. Operator TOML is a
read-only bind mount whose host mode grants read access only to its operator
owner and numeric group `10001`. A private mode-`0700` tmpfs at `/run/nama`
is the only general writable application area and owns ephemeral plugin launch
directories and Unix sockets. Plugins remain authenticated supervised
subprocesses with no TCP listener, inherited environment, database authority,
or durable state.

Compose allows 20 seconds for the existing request drain and plugin
process-group cleanup. Both services use `unless-stopped`; the core still fails
fast on startup database failures and reports later database loss through
readiness. Normal JSON lifecycle logs remain on stdout and safe pre-logger
startup failures remain on stderr.

The repository Docker gate builds and starts the real image, performs
Administrator setup and sign-in with the compiled Go CLI, tests and creates a
Jellyfin provider instance through the bundled executable, kills an in-flight
plugin child, proves recovery and application replacement, and requires a clean
`SIGTERM` exit. It uses the pinned disposable Jellyfin container only as a test
fixture; that fixture is not part of the application image and does not package
Jellyfin Server for operators.

TLS, ingress, image publication, signing, provenance, release versioning,
backup/restore, Kubernetes, and hostile-plugin sandboxing remain outside this
implemented deployment boundary.
