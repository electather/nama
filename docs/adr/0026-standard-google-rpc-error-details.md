# Normalize failures with Connect codes and standard Google RPC details

Clients need stable, cross-language failure semantics without depending on Nama-specific error shapes. Nama uses Connect codes with stable reasons and the standard `ErrorInfo`, `BadRequest`, `RequestInfo`, and `RetryInfo` details for application failures. This accepts normalization work at each boundary over a bespoke error envelope so clients can make safe retry and form decisions while retaining a code-based fallback.
