---
description: Worktree discipline — claim before create, one writer, remove only your own after Done
condition: 'git\s+worktree\s+(add|remove)'
scope: "tool:bash"
interruptMode: tool-only
---

Worktree operation detected — check the discipline before it runs:

- **Adding:** the issue must be claimed first (board status `In Progress`,
  before any edit), no `<issue>-` branch may already exist, the worktree
  name follows `<repo-slug>-<issue>-<slug>` beside the primary checkout, and
  the branch follows `<type>/<issue>-<slug>`. See `skill://worktree`.
- **Removing:** only a worktree **you** created, and only after its PR
  merged and the issue is `Done`. A worktree you did not create is another
  session's in-flight work — its dirty state is not yours to clean. `git
  worktree remove` refusing a dirty tree is information, not an obstacle:
  look before `--force`.
