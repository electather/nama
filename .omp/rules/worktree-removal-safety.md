---
condition: '(?:\bgit\s+worktree\s+remove\b|\bgit\s+branch\s+-D\b|\brm\s+-rf\b.*(?:herdr|worktree))'
scope: tool
interruptMode: always
---

Preserve a dirty worktree with `git stash push --include-untracked`. Close its Herdr workspace, remove the worktree, then verify Git, Herdr, and filesystem state. Keep its branch and stash unless requested.