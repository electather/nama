# Keep one active pairing per Apple app installation

Nama's MVP universal Apple application has one active Nama endpoint-bound Device credential per app installation, shared by every window. This keeps credential use, session invalidation, and system playback ownership unambiguous; candidate endpoints may be verified independently, but replacing the active pairing commits only after a fresh pairing at the candidate endpoint is durably stored, and multiple named endpoint profiles remain deferred.
