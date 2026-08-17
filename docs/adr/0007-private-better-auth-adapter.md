# Keep Better Auth private behind Nama-owned authentication RPCs

Nama's setup and authentication clients need stable Nama semantics rather than Better Auth's transport and model shapes. Better Auth is loaded only by a private runtime adapter behind Nama-owned authentication RPCs; its routes, cookies, errors, sessions, and models do not become public contracts. This retains replacement freedom instead of mounting Better Auth directly for clients to consume.
