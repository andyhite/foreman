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

Tracks come from the **native GitHub issue dependency graph**, not from
re-reading prose. `skill://grooming` records this graph at breakdown
time; read it, don't rebuild it by hand.

For each subtask, query its blockers:

```sh
gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by
```

Do this for every subtask and assemble the graph over the epic's
subtasks. Partition it into **tracks**:

- A **maximal chain of blocking edges** — subtask B blocked by A, C
  blocked by B, and so on — is one track, delivered by **one** worker as
  **stacked PRs** (`stacked-prs` skill): one worktree, one layer per
  subtask, review never blocking the next layer. Serial work goes to one
  worker on purpose — it accumulates the chain's context instead of
  learning it again for every subtask.
- Subtasks with no edge between them are independent tracks and may run
  concurrently, one single-subtask track each: plain dev loop, PR off
  the main branch.
- A cross-track dependency (track B needs track A's layer on the main
  branch) stays merge-gated: B dispatches only after that layer lands.
  If such edges are everywhere, the partition is wrong — refold the
  chains.

**Fallback for a repo without issue dependencies recorded**: parse
`Blocked by: #<n>` lines from each subtask's body instead. Same graph,
worse encoding — the partition logic above is unchanged, only the source
of edges differs.

The graph gives you ordering, not interface. Cross-task contracts —
shared interfaces, schema shapes, file ownership, naming — are still
fixed and commented on the epic before any dispatch, per step 2. Both
are needed and they are not the same thing: a correct partition
dispatched against a stale or missing contract still fails at
integration.

If a subtask is discovered mid-epic to depend on another, add a real
blocking edge (`skill://tracker` has the recipe) — not a note in a
comment or the epic thread. The next partition re-reads the graph, not
the conversation, so an edge that only exists as prose is invisible to
it and the tracks silently drift out of order.

Run tracks in parallel, at most `epicLoop.maxConcurrentTracks` workers
concurrently (`.omp/foreman.json`, default 3 — raise or lower it to match
this project's review bandwidth). `todo init`: one omp todo per subtask
grouped by track, an integration todo per landing, and a closeout phase.
This list is the only place tracking a multi-track epic is tractable —
**it is worthless if you create it and never touch it again.** The
failure mode to avoid: all these categorized track todos get created up
front, then nobody marks any of them done as tracks land, so the epic
finishes with every todo still open after real work shipped. Step 4 below
says exactly when each one flips.

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
worktree gone. **The instant you've verified a subtask landed, mark its
todo `done` — in that same turn, not batched for later.** Do this for
every subtask as it lands, not just the last one in a track: if a track
has three chained layers, that's three todos each flipped as each layer
merges, not one flip when the track finishes. If you reach step 6 and
find todos still open for subtasks the board says are `Done`, you skipped
verifying them when they actually landed — go verify now, don't just
close the todos to match the board.

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

1. **Todo audit first.** `todo view` the whole list. Every per-subtask and
   integration todo must be `done` (because you verified that landing
   when it happened, per step 4) or explicitly `drop`ped with a reason
   recorded in the same message. An open todo at this point means either
   you're not actually done, or you forgot to flip it when the work
   landed — find out which before continuing; don't paper over it by
   closing the list to match the outcome you're about to report.
2. Final integration pass (step 5) against the epic's own acceptance
   criteria — judge the epic against what it promised, not just against
   green checks. For an epic run as an expand / migrate / contract
   sequence over a wide refactor, "promised" includes the contract step:
   the epic is not done when the last migration batch lands, it is done
   when the contract lands and the old form is gone. A half-migrated
   expand left in the tree is the epic's worst failure mode — it looks
   finished (tests green, subtasks `Done`) and costs the next reader
   twice: once to discover the old form is still live, and again to
   finish the migration nobody tracked.
3. Summary comment on the epic: what shipped, per-subtask PRs, how the
   integrated behavior was proven, anything deferred (as linked issues,
   never as prose someone must remember).
4. Close the epic; board status `Done` (this is the one `Done` that isn't
   tied to a PR of its own).
5. Remove the integration worktree. The epic is not complete while it
   exists. Mark the closeout todo `done` last, once 1–4 above are
   actually true — not before.
