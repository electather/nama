# Make the CLI a thin public-API client

The `nama` CLI is a versioned process interface that parses and renders both Administrator management operations and current-principal application operations while the core retains business rules, authorization, persistence, and validation. Every operation has a non-interactive form, rather than embedding application behavior in the CLI or requiring an MVP web application.
