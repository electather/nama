# Expose one provider-neutral, domain-oriented public API

Consumer and management clients need one Nama-owned contract that does not expose remote-provider models or provider-specific consumer endpoints. Nama places both kinds of methods in one provider-neutral public package, while management can describe installed provider types and their configuration. This preserves provider replaceability at the cost of core-owned mapping and schema-driven management rather than separate management and consumer APIs or provider-specific endpoints.
