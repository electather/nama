# Run integrations as stateless supervised subprocesses

Integrations must be replaceable without transferring durable correctness and recovery ownership out of the core. The core launches authenticated plugin subprocesses over Unix sockets and owns configuration, credentials, schedules, retries, cursors, and durable state; plugins translate provider APIs without databases, queues, or migrations. A feasibility spike verified per-launch authentication, deadline cancellation, and clean socket rebinding, supporting this choice over in-process adapters or autonomous plugins.
