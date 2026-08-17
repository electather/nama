# Package one Linux application image with a separate PostgreSQL service

Nama's Linux deployment packages the core and first-party plugin executables in one application image while retaining plugin subprocess isolation; PostgreSQL is the only separate service. This favors home-operation simplicity over container-level plugin isolation, and remains unproven as a release artifact.
