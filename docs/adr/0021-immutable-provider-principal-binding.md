# Bind each provider instance to one immutable provider principal

A successful provider connection establishes one opaque provider-principal binding for its Nama provider instance. Credential or configuration changes may reconnect only as that principal; changing remote identity requires a new instance so provider replicas, source mappings, and synchronization history never cross users silently.
