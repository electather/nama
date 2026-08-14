# Authenticated Plugin IPC Lifecycle Spike Design

## Purpose

Resolve GitHub sub-issue #17 by proving the disposable Milestone 1 plugin IPC lifecycle through generated `nama.plugin.v1` services. The proof covers authenticated HTTP/1.1 ConnectRPC over a Unix domain socket, a core-owned runtime directory, deadlines, termination, clean restart, and stateless plugin behavior on the supported Linux production and macOS development platforms.

This spike records evidence for the accepted subprocess architecture. It does not create the Milestone 3 production supervisor.

## Scope

Temporarily add exact-pinned `@connectrpc/connect` and `@connectrpc/connect-node` 2.1.2 dependencies to `apps/server`. Add one focused Node test, a core-side lifecycle harness, and a disposable plugin child fixture in the server workspace. The child is a separate process and imports only generated plugin contract types plus ConnectRPC and Node APIs.

Run the proof natively on macOS and in the exact `node:24.19.0-bookworm-slim` Linux container image. Record the results and durable conclusions in `docs/architecture/plugin-system.md`, then remove all spike source, tests, dependency entries, and lockfile changes before final verification.

Do not change Protobuf schemas, generated bindings, public APIs, the Jellyfin adapter, runtime configuration, persistence, or root tasks. Do not add retries, restart budgets, log routing, idle shutdown, or other production supervision behavior.

## Security boundary

The core creates one temporary runtime directory and explicitly sets mode `0700`. The socket uses a fixed non-disclosing filename inside that directory and is never printed.

Each child launch receives a newly generated 32-byte random bearer and the socket path once through stdin. Neither value appears in argv, environment variables, stdout, stderr, test names, assertion messages, errors, or recorded evidence. The child consumes and closes stdin before serving.

A Connect interceptor authenticates every registered plugin RPC. It hashes the expected and presented bearer values and compares fixed-length digests with `timingSafeEqual`. Missing or incorrect authorization returns only Connect `UNAUTHENTICATED`; no secret, request body, provider reference, socket path, stack, or raw error crosses the transport.

## Transport and RPC behavior

The plugin child creates a Node HTTP/1.1 server with `connectNodeAdapter` and listens only on the Unix socket. It registers generated `nama.plugin.v1.HealthService.Check` and `nama.plugin.v1.LibraryService.GetItem` handlers.

The core creates generated clients through `createConnectTransport` with HTTP/1.1 and `nodeOptions.socketPath`. A client interceptor supplies the current launch bearer. Every call has an explicit deadline.

`HealthService.Check` returns `SERVING`. `LibraryService.GetItem` returns one valid synthetic movie using generated plugin messages. Its private reference is fixture-only, is never printed or asserted, and never crosses a public Nama boundary. Assertions inspect only provider-neutral fields such as title and kind.

The child applies a fixed test-configured delay to `GetItem`. One bounded call succeeds with a longer deadline. A second call uses a shorter deadline and must fail as `DEADLINE_EXCEEDED` while the child remains serving.

## Lifecycle and statelessness

The child reports readiness over Node's private parent/child IPC channel without including socket or secret data. The core verifies the runtime directory mode and socket presence without rendering their paths.

The first launch completes authenticated health and provider calls, rejects an invalid bearer, demonstrates the deadline, and then receives `SIGTERM`. The child closes the HTTP server, removes the socket, and exits cleanly.

The core restarts a new child on the same socket path with a fresh bearer. The previous bearer must fail, while the new bearer completes health and `GetItem`. After the second clean termination, the runtime directory must contain no plugin-created files. Restart success from the same compiled fixture and launch input, with no files surviving either process, proves no durable plugin state is required.

All cleanup runs from `finally`: terminate any live child, close clients by releasing process resources, remove the socket if necessary, and remove the temporary runtime directory.

## Behavioral test sequence

1. Add the focused lifecycle test against an intentionally unimplemented proof function.
2. Run it and retain the red result showing failure for the missing lifecycle behavior, not compilation or setup failure.
3. Implement the core harness and subprocess fixture.
4. Run the focused test green on macOS.
5. Run server type, format, and lint checks while the spike exists.
6. Run the same focused test in a pinned Node 24 Linux container.
7. Record exact commands, platform results, package versions, generated methods exercised, security outcomes, and stateless restart evidence in the plugin architecture note.
8. Remove the disposable implementation, test, dependencies, and lockfile changes.
9. Run `mise run check:ts` and `mise run check` on the retired tree.

The test captures child stdout and stderr and asserts that neither contains the launch bearer, socket path, fixture reference, credentials, or raw errors. Failure assertions use stable Connect codes and safe scalar values so the test runner cannot dump sensitive transport state.

## Durable conclusion and limits

A passing proof establishes that Node 24 and ConnectRPC 2.1.2 can serve and call generated unary plugin RPCs over an authenticated HTTP/1.1 Unix socket on macOS and Linux; deadlines cancel a bounded client call; subprocesses terminate and rebind cleanly; and the exercised plugin behavior needs no durable plugin state.

It does not establish production restart policy, crash-loop control, resource limits, stderr integration, provider connectivity, Jellyfin correctness, credential storage, scheduling, persistence, or container packaging. Those remain Milestone 3 responsibilities.