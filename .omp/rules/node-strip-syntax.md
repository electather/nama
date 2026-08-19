---
condition: '\bconstructor\s*\([^)]*\b(?:public|private|protected|readonly)\s+(?:readonly\s+)?[A-Za-z_$]'
scope: 'tool:edit(apps/server/src/**/*.ts), tool:write(apps/server/src/**/*.ts)'
interruptMode: always
---

Node 24 strip-only code needs ordinary fields and constructor assignments. Do not use TypeScript parameter properties.