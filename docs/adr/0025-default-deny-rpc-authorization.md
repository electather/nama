# Authorize generated RPC methods through a default-deny inventory

Every generated RPC crosses Nama's authority boundary, so an unclassified method must not become reachable by accident. Nama uses one explicit, default-deny inventory keyed by generated method descriptors; adding a method without an access rule fails descriptor-level verification, without a generic permission language or custom Protobuf authorization options. This accepts explicit inventory maintenance over handler-local checks or middleware defaults to prevent accidental public exposure and field-level oracles.
