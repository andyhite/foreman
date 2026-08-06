---
description: Snapshot the board — status counts, in-flight work, review queue, bug health
---

Produce a board snapshot. Read-only: query, never move anything.

Read `skill://tracker` for the board constants (run `/foreman:init` first
if `.omp/foreman.json` doesn't exist), then gather (parallelize the
queries):

- Counts per status, and the `To Do` column in order.
- `In Progress`: each item with its branch/worktree evidence (does a
  `<issue>-` branch exist? recent commits?) — flag items with none as
  possibly stale.
- `Review`: each item with its PR, CI state, and `reviewDecision` — flag
  merged-or-closed PRs whose issue never moved.
- Bugs: open top-severity bugs anywhere (these lead the report), untriaged
  plain `bug` labels, and the lower-severity backlog count.
- Ideas awaiting grooming (count and oldest), epics whose derived status
  disagrees with the board.

Present it compactly: a status table, then the flags — each flag with the
issue number and the one action that would fix it. If everything is clean,
say so in one line instead of padding.
