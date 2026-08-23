# Connection tests

Use `TestSupport.swift` for bounded eventual assertions and controllable
verifiers. `SetupStatusVerifierTests` owns URL protocol interception and must
restore it within each test. Add discovery or persistence coverage only with
the corresponding implementation.
