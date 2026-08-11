---
description: Worktree discipline — claim before create, one writer, remove only your own after Done
condition: 'git\s+worktree\s+(add|remove)'
scope: "tool:bash"
interruptMode: tool-only
---

Worktree operation detected — check the discipline before it runs:

- **Adding:** creation belongs to the orchestrating session — the one that
  claims the issue and dispatches the worker; a dispatched worker adding
  its own worktree is the violation this rule exists to catch. The issue
  must be claimed first (board status `In Progress`, before any edit), no
  `<issue>-` branch may already exist, the worktree name follows
  `<repo-slug>-<issue>-<slug>` beside the primary checkout, and the branch
  follows `<type>/<issue>-<slug>`. See `skill://worktree`.
- **Removing:** only a worktree that is **yours** — one you provisioned
  (for yourself or for a worker you dispatched), or one the harness handed
  you and the `provided` strategy accepted — and only after its PR merged
  and the issue is `Done`. A dispatched worker never removes its worktree:
  it reports the state and the orchestrator retires it. Any other worktree
  is another session's in-flight work; its dirty state is not yours to
  clean. `git worktree remove` refusing a dirty tree is information, not
  an obstacle: look before `--force`. The one pre-merge removal is the
  `unwind` operation — tearing down a *failed* provision that never
  received a worker, valid only after proving its branch commit-free.
- **Mechanism:** `policy.worktree.strategy` (`.omp/foreman.json`, default
  `git`) owns creation and removal. A raw `git worktree add`/`remove` is
  correct under `git`, and for scratch checkouts under any strategy. Under
  `herdr` it is wrong for an issue worktree — removing one that way orphans
  its workspace — and under `provided` the lifecycle is not yours at all.
