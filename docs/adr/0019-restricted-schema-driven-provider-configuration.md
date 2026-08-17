# Configure providers through one restricted schema-driven surface

Installed provider types publish a deterministic restricted JSON Schema profile that the same CLI or future UI can render and validate; Nama adds no provider-specific configuration methods. The profile deliberately gives up unrestricted JSON Schema expressiveness so clients render consistently while the core remains the authoritative validator.
