---
description: Orchestrate the board — or one epic — dispatching issue-workers into worktrees you provision
argument-hint: "[epic-number]"
---

Orchestrate delivery. Given an argument, the scope is epic #$1; bare, the
scope is the whole board — work through `To Do` until it is empty or
everything left is reserved, blocked, or awaiting a decision.

Read `skill://epic-loop`, `skill://tracker`, and `skill://stacked-prs`,
then run the orchestration loop exactly as written. **Board scope** selects
per its step 0: top-severity bugs first, blockers respected (hold back
anything blocked by an open issue), the column's own order for the rest;
broken-down epics expand into tracks, an epic without a breakdown routes
through `skill://grooming` with my sign-off, `ready-for-human` and `chart`
items are skipped, and the board is re-snapshotted after every landing
before the next dispatch. **Epic scope** runs the preflight (it must be a
broken-down epic — if the breakdown is missing, run it per
`skill://grooming` with my sign-off first), fixes the cross-task contracts
before any dispatch, and partitions the subtasks into dependency tracks.

Both scopes share one machinery, and **the worktrees are yours**: for
every track you claim the issue, provision its worktree through
`skill://worktree`, hand the path and branch to the worker in its brief,
and retire it after you verify the PRs merged and the issues `Done` —
workers never create or remove worktrees — under `fleet` dispatch,
provisioning and retirement run through `fleet spawn`/`fleet reap`, same
owner, same contract. Dispatch workers per `policy.epicLoop.dispatch`
(in-process `issue-worker` subagents by default; under `fleet`, separate
omp processes with you as the fleet boss), one per track, chain shape per
`policy.delivery.prStrategy`,
keep the derived board status current, run integration verification as
epic work lands through the `scratch-create` operation, file integration
findings as tracked issues, and close out with the final verification and
summary.

You conduct; you never edit product code, open task PRs, or merge
anything. **I merge** — surface what is ready and in what order (for a
stack, note that merging a layer takes everything below it), and my
comments on any PR are change requests for the owning worker. Verify
workers' claims against the board and the main branch, not their say-so.

**The todo list must track landings as they happen, not just exist at the
start.** The moment you verify a subtask actually landed (PR merged, issue
`Done`), mark its todo `done` in that same turn — across every track, not
only the last one to finish. Before you report closeout, audit the whole
list: every todo is `done` or explicitly `drop`ped with a reason: work
reported "shipped" with every todo still open means the tracks landed but
nobody verified them as they went.

Report at the end: track → issue → PR → status table, how the integrated
behavior was proven, anything deferred (as linked issues), every
provisioned worktree retired, and — at board scope — what remains on
`To Do` and why each item was not dispatched.
