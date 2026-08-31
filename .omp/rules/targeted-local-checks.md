---
condition: '\b(?:mise\s+run|pnpm(?:\s+run)?|npm\s+run|bun\s+run)\s+check(?![:\w])'
scope: tool
interruptMode: always
---

Local verification is targeted. Run only the owning subsystem, file, or scenario checks; never run the repository-wide aggregate (`mise run check`, root `pnpm run check`, or equivalent). CI owns the full aggregate.
