# Own HTTP lifecycle with one native Node listener

Nama needs one transport owner for health-route precedence, Connect delegation, request interruption, draining, and forced connection closure. The core uses one native Node listener for that lifecycle rather than Hono or another server abstraction. The native implementation accepts local mechanics so the required request and shutdown behavior remains under Nama's control.
