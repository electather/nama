---
condition: '.*'
scope: 'tool:edit(proto/**), tool:write(proto/**), tool:edit(apps/server/drizzle/**), tool:write(apps/server/drizzle/**), tool:edit(apps/server/src/database/**), tool:write(apps/server/src/database/**), tool:edit(apps/server/better-auth.config.ts), tool:write(apps/server/better-auth.config.ts)'
interruptMode: always
---

Boundary change. Confirm the request explicitly covers its public API, persistence, or security semantics; otherwise ask. Keep Protobuf changes additive and use the owning migration or generation workflow.