# Confirm durable revocation before reporting sign-out success

Better Auth can claim sign-out success after catching a session-deletion failure. Nama reports success only after the durable session store no longer resolves the presented bearer; it returns `UNAVAILABLE/SESSION_REVOCATION_UNCONFIRMED` otherwise. The extra durable read and an ambiguous result are preferable to falsely claiming that a credential was revoked.
