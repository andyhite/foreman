---
description: Drive the repo's backlog to merged — read the dependency graph, dispatch every ready ticket to the matching fleet worker, review and merge, recompute, repeat
---

Drive the backlog to merged. The tickets are the objective, you dispatch every
one of them that is ready, and you are the merge authority behind them.

Scope for this run:

$ARGUMENTS

Empty means everything the tracker reports as ready. Otherwise treat it as the
fence — a label, a milestone, an epic, a list of issue numbers. **Anything
outside the fence is not yours.** Do not break it down, do not start it, and
stop and ask before crossing.

Read `skill://fleet-dispatch` if you have not already. This command does not
replace the requirements gate in it. It batches it: one pass over the frontier,
one round of questions, one fan-out.

## Why this one merges

The per-ticket `/fleet:*` commands stop when the worker reports. That is fine
for one slice, and wrong for a backlog: a dependent ticket only reaches the
frontier when its blocker **closes**, and a blocker closes when its branch
merges. An orchestrator that reports and waits stalls after the first wave.

So the finish line here is merged, not reported. If the user wants to merge
themselves, they say so in the scope above and you stop at review — but then say
plainly that the frontier will not advance until they do.

## Prerequisites

Both are hard stops.

1. **A handle.** `fleet boss` must have been claimed by this pane, or workers
   send their questions somewhere else. A bare `fleet boss` prints the handle
   you already hold and changes nothing, so it is safe to run either way.
2. **`docs/agents/issue-tracker.md`.** It is the only thing that knows how to
   list issues, read dependencies, comment, and close in this repo. If it is
   missing, the repo was never set up: stop and tell the user to run
   `/setup-matt-pocock-skills`. Do not substitute a `gh` command you invented —
   this tracker may not be GitHub.

Read `docs/agents/triage-labels.md` too. The role names below are the canonical
ones; that file maps them to the strings this repo actually uses.

Open a todo list with every in-fence ticket on it, now. Mark one done in the
same turn you verify its merge — never in a batch at the end. A backlog reported
shipped with every todo still open means the work landed and nobody checked it.

## 1. Compute the frontier

**Query the dependency graph. Never infer order from issue numbers or from
prose.** The tracker file names the mechanism — native issue dependencies, a
`Blocked by:` line, a task list in a parent. Use that one. A ticket is ready when
it has no *open* blocker.

Then reduce the ready set to what is dispatchable now:

- **`ready-for-agent` only.** That label means "fully specified, ready for an
  AFK agent", which is the same bar a fleet brief has to clear. Nothing without
  it goes to a worker.
- **Drop anything already claimed.** An assignee means a human took it. Run
  `fleet ls` too — a ticket whose worker is alive from an earlier run must not
  be dispatched twice.
- **Drop epics and parents.** Their status derives from their children. Work the
  children.

Then look at the shape of the graph before you dispatch into it:

- **Do not manufacture parallelism the graph does not have.** If the frontier is
  two tickets and one of them unblocks a chain, that is a two-worker wave, not a
  reason to force more out the door.
- **Name the choke points.** A ticket whose output several later tickets consume
  — a schema, a wire format, an id convention — fixes a contract they inherit.
  Say so in its brief, and read its result carefully rather than skimming it.

What falls out still needs saying. Report it once, in one block:

| Role | What you do with it |
|---|---|
| `needs-triage` | Offer to run `skill://triage` here. It is interview work; it stays with you. |
| `needs-info` | Blocked on a person. Name the ticket and who owes the answer. |
| `ready-for-human` | Never dispatch. Count it. |
| `wontfix` | Ignore. |

## 2. Classify each ready ticket

| The ticket is | Worker reads | Branch |
|---|---|---|
| a change to build against a spec | `skill://implement` | `feat/<n>-<slug>` |
| something broken or slow, with a symptom | `skill://diagnosing-bugs` | `fix/<n>-<slug>` |
| a question whose deliverable is a committed write-up | `skill://research` | `spike/<n>-<slug>` |
| a design question needing something runnable | `skill://prototype` | `spike/<n>-<slug>` |
| a review of a branch that already exists | `skill://code-review` | `review/<n>-<slug>` |

Follow the repo's branch convention where it has one; the above is the fallback.

**Two kinds of ticket never reach a worker.**

*Decisions.* A ticket whose deliverable is an answer recorded on the ticket —
not a branch, not a PR — is yours. Resolve it here with `scout` or `librarian`
subagents in parallel, or a `task` subagent in a scratch directory when it needs
something runnable. Then record the resolution on the ticket, close it, and
update whatever parent or map indexes it **in the same pass**. An index that
lags its tickets is worse than none. Do these early: a decision the rest of the
backlog is shaped around is worth knowing before you dispatch into it.

*Trivia.* A one-line diff, a version bump, a doc typo. Do it yourself with a
`task` subagent and say you did. A branch is more ceremony than the change.

## 3. Close the gaps in one round

`ready-for-agent` means the ticket is specified. It does not mean the specific
answers a given skill stalls without are in the ticket body:

| Kind | Cannot start without |
|---|---|
| implement | the spec inline, or a reference the worker can fetch; the **seams** `/tdd` will test at, since it refuses an unconfirmed one; decisions already made — libraries, patterns, code to reuse |
| diagnosing-bugs | the exact symptom text; how to trigger it, including fixtures or services; how often; the known-good commit if any; environment |
| research | the question, sharp enough to be answerable; which sources count as primary; where the write-up goes |
| prototype | the design question it answers; what "runnable" means here; that the code is throwaway |
| code-review | the **fixed point** to diff against; the spec to compare behaviour to, or an explicit "no spec, skip that axis"; where the report is written |

Walk the whole frontier against that table first, then ask the user everything
missing in **one** message. A round trip per ticket is how a backlog run turns
back into the interview you were trying to batch.

If the ticket body names its own test seams, they are binding. Do not invent a
different one because you would have picked differently.

A ticket whose gaps the user cannot close now falls out of this wave. Do not
dispatch a brief you could not defend, and do not stall four ready tickets
waiting on the fifth.

**Secrets never enter a brief.** If a reproduction needs credentials, name the
env vars carrying them and tell the worker to write `<REDACTED>`, not the value.

## 4. Announce the wave

Print it and dispatch. Do not ask permission — you were told to work the
backlog, and a yes/no per wave turns an autonomous drain back into a meeting:

| # | Ticket | Kind | Branch | Unblocks | Worker reads |
|---|---|---|---|---|---|

The things that genuinely stop you are elsewhere: an unanswerable gap in step 3,
the fence in the scope line, and the escalation list in step 6.

Two things decide who is in the wave:

- **The cap.** Three concurrent code workers unless the repo says otherwise. A
  fleet worker is a full `omp` process, not a subagent; they are not free, and a
  worker blocked waiting on your attention is worse than one that starts later.
- **File overlap.** Two workers editing the same files produce conflicting
  branches and nothing resolves that for you. Hold the second back and say why.

## 5. Dispatch

Write every brief to `/tmp/fleet-<n>.md` before spawning anything. The shape is
the one in `skill://fleet-dispatch` — an invocation line, then the answers from
step 3, then scope and acceptance:

```markdown
Read `skill://<the skill for this kind>` and follow it for the work below.

## <Spec | Symptom + Reproduction | Question | Design question | Fixed point>
<the answers from step 3, in full>

## Scope
<files and modules in play; then the explicit non-goals>

## Done when
<checkable criteria>

## Handoff
Open a PR against <base> when the work is done, move the ticket to review per
this repo's tracker conventions, then `fleet report` with the PR number and one
line on how you proved it. Do not merge — I do that, and my merge is the
approval you are waiting for.
```

That Handoff section is the one thing a backlog brief adds. `fleet`'s own
protocol block tells the worker to commit, report, reply, and stay in its
worktree — never repeat any of that — but it stops short of a PR, and a merge
authority needs one to review.

Add the context the worker cannot derive: constraints inherited from a parent
epic, and for a choke-point ticket, that it owns a contract other tickets
consume.

Then spawn the whole wave and block once:

```bash
fleet spawn feat/412-webhook-retry --base origin/main --task-file /tmp/fleet-412.md
fleet spawn fix/418-duplicate-send --base origin/main --task-file /tmp/fleet-418.md
fleet join
```

Never a chain of `fleet ask` — that serializes the thing you came here to
parallelize.

Reviews are the exception to `--base`: `skill://code-review` diffs in its own
checkout, so branch the reviewer off the tip under review —
`fleet spawn review/412 --base feat/412-webhook-retry`.

## 6. Review, merge, recompute

`fleet join` is a barrier — it returns when **every** live worker has settled,
not one at a time. So this is a wave, not a rolling queue: you cannot backfill a
finished worker's slot while its siblings are still running, and you should not
try. Answer anything tagged `[fleet:<handle>]` with `fleet send` as it preempts
you, then `fleet join` again; re-joining is safe.

When the wave settles, take each report in turn:

1. **Verify against the tracker and the base branch, not the report.** The PR
   exists, CI is green, the ticket is at review, and the acceptance criteria in
   the ticket body are actually met *by the diff*. A worker's summary of its own
   work is a claim, not evidence.
2. **Merge the way this repo merges.** Match its history: a repo with one
   logical change per commit and conventional subjects wants a rebase merge, and
   a squash would collapse exactly what it is keeping. Delete the branch.
3. **Confirm the ticket closed,** update any derived parent or epic status, mark
   its todo done, and `fleet reap <handle>`. `reap` refuses a dirty worktree —
   that refusal is protecting uncommitted work, so read the diff before reaching
   for `--force`.

Then recompute the frontier from step 1 and dispatch the next wave. Merge the
whole settled wave before recomputing — one merge typically unblocks one or two
tickets, and computing the frontier halfway through leaves them out of it.

**A failing review goes back to its worker.** Comment the change request on the
PR, `fleet send` the worker to address it, move the ticket back. Do not fix it
yourself — you would be reviewing your own patch on the next pass.

**Escalate instead of merging** when CI is red and the worker says it is
unrelated; when a PR changes a shared contract beyond what its ticket describes;
when a worker reports it could not meet an acceptance criterion; or when two PRs
conflict in a way that needs a scope decision.

Stop when the fence is empty, when everything left is gap-blocked or
human-blocked, or when the user says stop. Then report once: ticket → PR →
status, what any decision tickets settled and what that changed, anything
deferred as a linked ticket, and the final state of the todo list.

## The rules you keep

- **You do not implement.** Editing product code means you stopped orchestrating.
- **You keep the tracker true.** It is the only shared memory between concurrent
  workers. Move state the moment it changes — a ticket nobody moved reads as
  available, and the next pass dispatches it twice.
- **You do not dispatch what is not ready.** The triage label and the dependency
  graph are the gates. Promoting past either is the user's call, made here, on
  purpose.
- **You do not run waves of one** when the frontier had five. Serial dispatch is
  a slow, expensive `task` loop.
