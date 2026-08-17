# Contain the playback engine behind one concrete Nama adapter

The selected playback engine is imported only by one concrete Nama-owned adapter; features use Nama request, state, clock, track, and error values instead of engine types. No engine is selected and no client is implemented yet. Local mapping and lifecycle work contain replacement, rendering, invalidation, and security risk without a speculative multi-engine interface.
