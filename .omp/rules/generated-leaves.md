---
condition: '.*'
scope: 'tool:edit(gen/**), tool:write(gen/**), tool:edit(apps/server/src/database/auth-schema.ts), tool:write(apps/server/src/database/auth-schema.ts)'
interruptMode: always
---

Generated leaf. Never edit it by hand. For `gen/**`, change `proto/` or generation config, then run `mise run generate`. For the auth schema, change `apps/server/better-auth.config.ts`, then run `pnpm --filter @nama/server run generate:auth-schema`.