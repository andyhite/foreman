---
name: epic-loop
description: Orchestrating delivery of an epic under the foreman workflow — partitioning subtasks into dependency tracks, dispatching issue-worker subagents in parallel (stacked PRs for chained tracks), integration verification as work lands, derived epic status, and closeout. Read when picking up an epic issue.
---

# Epic loop — orchestrate, verify, integrate

An epic is delivered by running the `dev-loop` on each subtask — but never
by you directly. You are the **conductor**: you sequence, dispatch, watch,
integrate, and verify. You do not edit product code, create task worktrees,
or open task PRs; `issue-worker` subagents do that. Related skills:
`tracker` (statuses, sub-issue queries, derived epic status), `stacked-prs`
(chained subtasks), `grooming` (breakdown), `bug-triage` (integration
findings), `verification`, `worktree`.

## 1. Preflight

- The issue is labeled epic. A task or bug goes to the `dev-loop` instead.
- It has subtasks (tracker skill: sub-issue query). **No breakdown, no
  dispatch** — run the breakdown procedure from the `grooming` skill first
  (with the operator in the loop), then come back.
- Subtasks you intend to dispatch are at `To Do`. A subtask already
  `In Progress` belongs to another session — coordinate via the board and
  `hub`, never by dispatching a second writer.

## 2. Read everything, then fix the contracts

Read the epic, every subtask, and the spec/design sections they cite. Then
decide — **before any dispatch** — the cross-task contracts: shared
interfaces, schema shapes, file ownership, naming. Two workers negotiating a
contract mid-flight is how integration fails. Write the contracts as a
comment on the epic (so they survive you) and into every worker brief that
touches them.

If reading reveals the breakdown is wrong — tasks too big, a missing seam, a
dependency nobody recorded — fix the breakdown first (grooming skill),
don't dispatch around it.

## 3. Partition into tracks

Build the dependency graph over subtasks, then partition it into **tracks**:

- A **chain** — subtasks where each depends on the previous one — is one
  track, delivered by **one** worker as **stacked PRs** (`stacked-prs`
  skill): one worktree, one layer per subtask, review never blocking the
  next layer. Serial work goes to one worker on purpose — it accumulates
  the chain's context instead of re-learning it per subtask.
- An independent subtask is a single-subtask track: plain dev loop, PR off
  the main branch.
- A cross-track dependency (track B needs track A's layer on the main
  branch) stays merge-gated: B dispatches only after that layer lands. If
  such edges are everywhere, the partition is wrong — refold the chains.

Run tracks in parallel, at most **3 workers** concurrently. `todo init`: one
omp todo per subtask grouped by track, an integration todo per landing, and
a closeout phase.

## 4. Dispatch and monitor

One `task` batch per ready set of tracks, `agent: issue-worker`, one item
per track. Each brief is self-contained (workers start blank): the issue
number(s) — for a chained track, the ordered list with the instruction to
deliver it as a stack per `skill://stacked-prs` — the epic number, the
contracts from step 2, and anything a sibling's landed work changed.

While tracks run:

- Monitor with `hub` (`jobs`, `wait`); answer worker questions promptly —
  an unanswered contract question stalls a whole track.
- Keep the epic's derived status current (tracker skill) as subtasks move.
- **Surface the merge queue to the operator**: whenever layers or PRs go to
  `Review`, tell the operator what is ready and in what order — for a
  stack, that merging layer K takes everything below it, and merging the
  top takes the whole track. The operator merges; nobody else. A comment
  from the operator on any PR is a change request the owning worker must
  pick up.
- A stuck worker gets steered via `hub send`; a dead one gets its issues
  reset (blocker comment, status back to `To Do`) and its track
  redispatched or split.
- Two plain-PR tracks colliding on the same files: tell the later one to
  rebase after the first lands, or serialize them.

A worker's "completed" is a claim. Verify it: PRs merged, issues `Done`,
worktree gone.

## 5. Integrate as work lands

Each track's top-of-stack rung-3 verification already proves the track's
layers work **together**. What it cannot prove is tracks working with
_each other_ — that is yours. After each meaningful landing on the main
branch (a track completing, or a batch of merges):

```sh
PRIMARY=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')
git -C "$PRIMARY" fetch origin <mainBranch>
git -C "$PRIMARY" worktree add "$PRIMARY/../<repo-slug>-<epic>-integration" \
  --detach origin/<mainBranch>
```

(Reuse it across landings: `git -C ../<repo-slug>-<epic>-integration fetch
origin && git -C ../<repo-slug>-<epic>-integration checkout --detach
origin/<mainBranch>`.)

In it: install dependencies, run the repo's full verify script and e2e
gate, and — most importantly — **exercise the epic's behavior across the
seams** that just joined, per rung 3 of the `verification` skill.

Findings are never fixed by you in the integration worktree. File each one:
a defect in landed work is a bug (`bug-triage` skill, usually the
second-highest severity since it blocks the epic); a missing seam is a new
subtask (grooming breakdown addendum, linked to the epic). Dispatch fixes
as their own track.

## 6. Closeout

When every subtask is `Done`:

1. Final integration pass (step 5) against the epic's own acceptance
   criteria — judge the epic against what it promised, not just against
   green checks.
2. Summary comment on the epic: what shipped, per-subtask PRs, how the
   integrated behavior was proven, anything deferred (as linked issues,
   never as prose someone must remember).
3. Close the epic; board status `Done` (this is the one `Done` that isn't
   tied to a PR of its own).
4. Remove the integration worktree. The epic is not complete while it
   exists.
