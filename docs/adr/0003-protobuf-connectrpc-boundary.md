# Use Protobuf and ConnectRPC as Nama's versioned RPC boundary

Nama's public and plugin boundaries need versioned contracts that generated clients can share across languages. Nama defines those contracts in Protobuf, compiles them through Buf, and serves them only through Connect over HTTP; it does not add REST, GraphQL, gRPC, or gRPC-Web surfaces. This chooses generated, additive cross-language compatibility over looser HTTP evolution and handwritten clients.
