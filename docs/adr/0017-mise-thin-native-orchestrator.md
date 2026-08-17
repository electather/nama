# Use Mise only as a thin orchestrator over native owners

Nama uses Mise to pin command-line tools and expose discoverable root tasks, while native manifests and ecosystem tools retain ownership of dependencies, builds, formatting, linting, generation, and tests. This keeps polyglot workflows coordinated without replacing the configuration each ecosystem already owns with a root build graph, cache, or custom wrapper.
