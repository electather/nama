# Keep public and plugin Protobuf packages independent

Public clients and private plugin subprocesses have distinct trust, identity, and compatibility boundaries. `nama.api.v1` and `nama.plugin.v1` do not import each other or a shared third Protobuf package, so similar messages are declared separately. Nama accepts that duplication instead of coupling independently evolving public and plugin contracts.
