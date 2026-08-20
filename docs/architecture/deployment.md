# Deployment and exposure

Status: the Linux deployment is accepted target architecture; an installable
release artifact is not yet proven.

[ADR-0016](../adr/0016-linux-application-image-and-postgresql.md) packages the
Node core and first-party plugin executables in one Nama application image while
retaining separate plugin subprocesses. PostgreSQL 18 is the only separate
service.

The supported MVP deployment is Linux with Docker Compose: persistent database
data and explicit configuration are mounted, health checks and graceful
`SIGTERM` are required, and logs go to stdout/stderr. Nama binds as configured
but does not provision TLS, domains, tunnels, or a reverse proxy—users choose
direct LAN, VPN, or their own proxy—and local development on macOS follows the
same process boundaries. Clustering, Kubernetes, embedded ingress, automatic
certificates, and Windows production support are not release requirements.

The disposable Jellyfin container in the server integration gate is a test
fixture only. It does not prove or change the deferred Nama application image.
