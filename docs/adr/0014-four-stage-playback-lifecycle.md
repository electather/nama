# Model playback as plan, open, report, and close

Nama models playback as a side-effect-free expiring plan, one idempotently materialized session, ordered telemetry, and idempotent terminal cleanup. The public and plugin packages mirror those four stages without sharing messages. The protocol's extra states isolate locator expiry, provider materialization, telemetry ordering, and cleanup ambiguity that a one-RPC playable URL cannot express.
