---
description: Deliver an epic by orchestrating issue-worker subagents
argument-hint: "<epic-number>"
---

Deliver epic #$1 by orchestration.

Read `skill://epic-loop`, `skill://tracker`, and `skill://stacked-prs`, then
run the epic loop exactly as written: preflight (it must be a broken-down
epic — if the breakdown is missing, run it per `skill://grooming` with my
sign-off first), fix the cross-task contracts before any dispatch,
partition the subtasks into dependency tracks, dispatch `issue-worker`
subagents (one per track, chained tracks as stacked PRs, at most 3
concurrent), keep the epic's derived board status current, run integration
verification as work lands in an integration worktree, file integration
findings as tracked issues, and close out with the final verification and
summary.

You conduct; you never edit product code, open task PRs, or merge
anything. **I merge** — surface what is ready and in what order (for a
stack, note that merging a layer takes everything below it), and my
comments on any PR are change requests for the owning worker. Verify
workers' claims against the board and the main branch, not their say-so.

Report at the end: track → subtask → PR → status table, how the integrated
behavior was proven, anything deferred (as linked issues), integration
worktree removed.
