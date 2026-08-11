---
name: epic-loop
description: Orchestrating delivery under the foreman workflow — the whole board when no epic is named, or a single epic — selecting what runs next by severity and blockers, partitioning work into dependency tracks, provisioning a worktree per track, dispatching issue-worker subagents in parallel (stacked PRs for chained tracks), integration verification as work lands, derived epic status, and closeout. Read when orchestrating the board or picking up an epic issue.
---

# Orchestration loop — the board, or one epic

Work is delivered by running the `dev-loop` on each issue — but never by
you directly. You are the **conductor**: you sequence, claim, provision
worktrees, dispatch, watch, integrate, and verify. You do not edit product
code or open task PRs; `issue-worker` subagents do that, inside checkouts
**you** create and retire — a worker never manages its own worktree.
Related skills:
`tracker` (statuses, sub-issue queries, derived epic status), `stacked-prs`
(chained subtasks), `grooming` (breakdown), `bug-triage` (integration
findings), `verification`, `worktree`.

## 0. Scope — one epic, or the whole board

Named an epic? Continue to step 1. Handed a single task or bug
(`/foreman:work <n>`)? This same loop runs with the queue pinned to that
issue — selection collapses to a queue of one and everything else below
is unchanged. Dispatched bare (`/foreman:orchestrate` with no argument),
the unit is the board itself, and selection is yours:

1. **Snapshot `To Do`** (tracker skill), top to bottom — the column order
   is the operator's priority; inherit it, don't re-derive it.
2. **Filter.** Skip `labels.readyForHuman` items (reserved for a human),
   `labels.chart` tickets (decisions — resolved by charting, never
   dispatched), anything already `In Progress` (another writer owns it),
   and untriaged bugs (severity first, per `skill://bug-triage`; triage is
   a board move, not a dispatch).
3. **Order.** Open top-severity bugs lead, in `labels.bugSeverities`
   order. Then dependency order: query each candidate's blockers (step 3's
   recipe) and hold back anything blocked by an open issue — a blocked
   dispatch just parks a worker against work that cannot land. Among
   unblocked peers, keep the column order.
4. **Expand epics.** A task or bug is a single-issue track as it stands. A
   broken-down epic contributes its subtask tracks — run steps 1–3 for it
   (preflight, contracts, partition) — and gets its own integration and
   closeout (steps 5–6). An epic without a breakdown is not dispatchable:
   route it through `skill://grooming` with the operator, and keep working
   the rest of the board meanwhile.
5. **One pool, one cap.** Tracks from every source — epics and standalone
   issues alike — share one dispatch pool and the
   `policy.epicLoop.maxConcurrentTracks` cap. After each landing, and
   before every new dispatch, re-snapshot the board: a merge may have
   unblocked a dependent, the operator may have reordered `To Do`, and a
   fresh top-severity bug preempts anything not yet dispatched.
6. **Stop honestly.** The loop ends when `To Do` is empty or everything
   left is reserved, blocked, or awaiting a decision — report what
   remains and why each item was not dispatched, one line each.

The todo discipline below applies at board scope too, scoped to what you
actually dispatch: one todo per dispatched issue, grouped by track — never
one per backlog item you might get to.

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
  blocked by B, and so on — is one track, delivered by **one** worker.
  `policy.delivery.prStrategy` (`.omp/foreman.json`, default `stacked`)
  decides its mechanism:
  - `stacked`: deliver the chain as stacked PRs per `skill://stacked-prs`:
    one track worktree, one layer per subtask, review never blocking the
    next layer.
  - `sequential`: deliver the chain as plain PRs, dispatching each layer
    only after the previous layer merges.
  Serial work goes to one worker at either setting on purpose — it
  accumulates the chain's context instead of learning it again for every
  subtask.
- Subtasks with no edge between them are independent tracks and may run
  concurrently, one single-subtask track each: plain dev loop, PR off
  the main branch. `sequential` affects a chain only; it does not
  serialize independent tracks.
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

Run tracks in parallel, at most
`policy.epicLoop.maxConcurrentTracks` workers concurrently
(`.omp/foreman.json`, default 3 — raise or lower it to match this
project's review bandwidth). `todo init`: one omp todo per subtask grouped
by track, an integration todo per landing, and a closeout phase. This list
is the only place tracking a multi-track epic is tractable — **it is
worthless if you create it and never touch it again.** The failure mode to
avoid: all these categorized track todos get created up front, then nobody
marks any of them done as tracks land, so the epic finishes with every todo
still open after real work shipped. Step 4 below says exactly when each one
flips.

## 4. Dispatch and monitor

**Provision before you dispatch — worktrees are yours, not the workers'.**
For each track about to go out: claim its first issue — board status
`In Progress` (tracker skill) — then invoke `create` from
`skill://worktree`: `create <issue> <type> <slug>` for a single-issue
track, or the track worktree named per `skill://stacked-prs` for a stacked
chain. Under `sequential`, provision each layer's issue worktree at that
layer's dispatch, after the previous layer merges. Claim, then create —
never the reverse — and hand the resulting path and branch to the worker
in its brief. A worker never creates, and never removes, a worktree.

**A failed provision unwinds immediately — the claim must not outlive the
failure.** `create` can fail after the claim: a branch collision, a fetch
error, a failing `commands.install`. When it does, tear down whatever the
attempt left through the strategy's `unwind` operation
(`skill://worktree`) — the failure-path teardown that proves the branch
commit-free before force-removing the partial checkout; `remove` stays
reserved for merged work. Then comment the failure on
the issue, and move its status back to `To Do` — a board that says
`In Progress` with no worker and no worktree is a lie every later
selection pass trips over. Two failure shapes are not retried in place: a
collision with a live `<issue>-` branch means the issue was already
claimed elsewhere — back off entirely, it belongs to another session; and
a strategy failure (`herdr` without `HERDR_ENV`, a `provided` handoff
failing validation) is a `/foreman:doctor` finding — repair the
mechanism first, then re-claim and retry, never loop the claim against a
broken strategy.

`policy.epicLoop.dispatch` (`.omp/foreman.json`, default `subagent`)
selects the dispatch mechanism. The ownership contract above — you claim,
you provision, you retire, one writer per track — is identical at either
value; only the machinery changes.

| Value | Mechanism |
| --- | --- |
| `subagent` | In-process `issue-worker` subagents: provision per the contract above, then one `task` batch per ready set of tracks, one item per track. Monitor with `hub` (`jobs`, `wait`). |
| `fleet` | Separate omp processes in herdr worktree workspaces, driven by the operator's `fleet` CLI. You are the **fleet boss**: claim the handle once with `fleet boss` before any spawn. Provision and dispatch fuse — after claiming the issue on the board, `fleet spawn <type>/<issue>-<slug> --base origin/<mainBranch> --task-file <brief>` creates the worktree and starts the worker in one command; the provision-before-dispatch contract holds because both halves stay in your hands. Monitor with `fleet join`. `hub`, `history://`, and `agent://` never reach a fleet worker. |

Under `fleet`, three deltas bind:

- **The brief must say everything — including "push and open the PR."** A
  fleet worker does not push or open PRs unless its task says to: instruct
  the full dev loop (`skill://dev-loop`) explicitly, and let `fleet`
  append its own protocol block rather than repeating it.
- **Questions preempt you.** A blocked worker's `fleet reply` arrives as a
  `[fleet:<handle>]` message that interrupts even a running `fleet join`.
  Answer with `fleet send <handle> "..."`, then re-run `fleet join` — it
  re-waits on whoever is still working.
- **Retirement is `fleet reap <handle>`** once that track's PRs merged and
  its issues are `Done` — `reap` refusing a dirty tree is information,
  exactly as `remove`'s refusal is — followed by deleting the merged local
  branch, which `reap` deliberately leaves. A failed spawn is a failed
  provision: `reap` the commit-free worktree and put the status back to
  `To Do`, per the unwind rule above.

`fleet` requires `HERDR_ENV` and the `fleet` CLI on `PATH`; missing either
is a `/foreman:doctor` finding, never a silent downgrade to `subagent`.
The `maxConcurrentTracks` cap governs spawns exactly as it governs
subagents: spawn up to the cap, `fleet join`, verify what landed,
re-snapshot, refill.

Dispatch per the table above — a `task` batch under `subagent`, one
`fleet spawn` per track under `fleet`. Each brief is self-contained
(workers start blank): the issue
number(s); the branch; under `subagent` the **provisioned worktree path —
the only place that worker writes** (a fleet worker starts *inside* its
worktree before any path exists to name: it asserts its own `$PWD`, and
you record its handle → branch → path from `fleet ls` immediately after
the spawn, for verification and retirement); for a chained track, the
ordered list and its
delivery instruction from `policy.delivery.prStrategy`
(`.omp/foreman.json`, default `stacked`) — stacked PRs per
`skill://stacked-prs` for `stacked`, or plain PRs dispatched
one-after-another after each prior merge for `sequential`; the epic number
and the contracts from step 2 when the track belongs to an epic; and
anything a sibling's landed work changed.

While tracks run:

- Monitor with `hub` (`jobs`, `wait`) — under `fleet`, with `fleet join`,
  answering `[fleet:<handle>]` questions via `fleet send`. Answer worker
  questions promptly — an unanswered contract question stalls a whole
  track.
- Keep the epic's derived status current (tracker skill) as subtasks move.
- **Surface the merge queue to the operator**: whenever layers or PRs go to
  `Review`, tell the operator what is ready and in what order — for a
  stack, that merging layer K takes everything below it, and merging the
  top takes the whole track. `policy.delivery.mergePolicy`
  (`.omp/foreman.json`, default `operator`) decides the merger: under
  `operator`, the operator merges; under `agent-on-green`, the owning
  worker may merge only after CI is green, QA returned `PASS`, and no
  operator comment is unresolved. A stack remains bottom-up, one layer at
  a time, with that gate re-checked for each layer; never merge the top as
  a shortcut. A comment from the operator on any PR is a change request
  the owning worker must pick up.
- A stuck worker gets steered via `hub send` (under `fleet`: `fleet
  send`); a dead one gets its issues reset (blocker comment, status back
  to `To Do`) and its track redispatched or split. The worktree you
  provisioned survives the worker: redispatch into it (under `fleet`, a
  follow-up to a live worker goes through `fleet ask <handle>`), or
  retire it — never leave it orphaned.
- Two plain-PR tracks colliding on the same files: tell the later one to
  rebase after the first lands, or serialize them.

A worker's "completed" is a claim. Verify it: PRs merged, issues `Done` —
then **retire what you provisioned**: invoke the `remove` operation from
`skill://worktree` for the track's worktree and local branch — under
`fleet` dispatch, `fleet reap <handle>` plus deleting the merged local
branch, per the dispatch table. The worker
reports its worktree's state; it never removes it. Under
`policy.worktree.strategy: provided` (`.omp/foreman.json`, default `git`)
the harness owns the lifecycle — verify the worker's report that the
harness retains the checkout instead. **The instant
you've verified a subtask landed, mark its todo `done` — in that same turn,
not batched for later.** Do this for every subtask as it lands, not just
the last one in a track: if a track has three chained layers, that's three
todos each flipped as each layer merges, not one flip when the track
finishes. If you reach step 6 and find todos still open for subtasks the
board says are `Done`, you skipped verifying them when they actually
landed — go verify now, don't just close the todos to match the board.

## 5. Integrate as work lands

Each track's top-of-stack rung-3 verification already proves the track's
layers work **together**. What it cannot prove is tracks working with
_each other_ — that is yours. After each meaningful landing on the main
branch (a track completing, or a batch of merges):

Invoke `scratch-create <repo-slug>-<epic>-integration
origin/<mainBranch>` from `skill://worktree`.

This is a **scratch** checkout, not an issue worktree: reuse that named,
detached checkout across landings and refresh its `origin/<mainBranch>` ref
through `scratch-create`'s contract rather than inlining its mechanism. It
never gets a workspace, a pane, or an agent, even when the selected
worktree strategy gives issue worktrees all three; integration is
agent-only and throwaway by design.

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
5. Invoke `scratch-remove <repo-slug>-<epic>-integration` from
   `skill://worktree`. The epic is not complete while it exists. Mark the
   closeout todo `done` last, once 1–4 above are actually true — not
   before.
