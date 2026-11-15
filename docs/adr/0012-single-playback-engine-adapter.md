# Contain the playback engine behind one concrete Nama adapter

The selected playback engine is imported only by one concrete Nama-owned
adapter; features use Nama request, state, clock, track, and error values instead
of engine types. This decision preceded engine selection; ADR-0032 later chose
AetherEngine `6.21.0`. Local mapping and lifecycle work contain replacement,
rendering, invalidation, and security risk without a speculative multi-engine
interface.
