# Make the management CLI a thin public-API client

The management CLI is a versioned process interface that parses and renders public operations while the core retains business rules, authorization, persistence, and validation. Every operation has a non-interactive form, rather than embedding management behavior in the CLI or requiring an MVP management web application.
