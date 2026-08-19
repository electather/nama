---
condition: '(?:from|import)\s*\(?\s*["'']\.\.?/[^"'']+\.js["'']'
scope: 'tool:edit(apps/server/src/**/*.ts), tool:write(apps/server/src/**/*.ts)'
interruptMode: always
---

Handwritten server ESM imports name relative modules with `.ts`. Retain `.js` only in generator-owned packages.