# Connection

Read the Connection section of
[`../../../../docs/architecture/ios-app.md`](../../../../docs/architecture/ios-app.md).

- Keep `Connect` and `NamaAPI` imports inside `SetupStatusVerifier.swift`;
  feature state and views remain transport-free.
- Preserve `ConnectionFeature` attempt identity when changing task ownership so
  stale completions stay ineffective.
- Keep Connection test support in `NamaTests/Connection`; use
  `TestSupport.eventually` for asynchronous assertions.
