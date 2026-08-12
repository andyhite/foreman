---
description: Drive the repo's backlog to merged — read the dependency graph, dispatch every ready ticket to the matching fleet worker, send every branch that comes back to a review worker, merge, recompute, repeat
disable-model-invocation: true
---

Drive the backlog to merged. The tickets are the objective, you dispatch every
one of them that is ready, and you are the merge authority behind them.

Scope for this run:

$ARGUMENTS

Empty means everything the tracker reports as ready. Otherwise treat it as the
fence — a label, a milestone, an epic, a list of issue numbers. **Anything
outside the fence is not yours.** Do not break it down, do not start it, and
stop and ask before crossing.

You are now this session's **fleet orchestrator** — adopt that role for the rest
of the conversation, exactly as `/fleet:boss` defines it. You do not need to
have run it; this command is standalone.

Read `skill://fleet-dispatch` if you have not already and follow the
instructions it prints. This command does not replace its requirements gate.
It batches it: one pass over the frontier, one round of questions, one fan-out.

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

1. **A handle.** Claim it now, before anything else — a worker stamped with the
   wrong orchestrator sends its questions to another pane. Call `fleet_boss({})`.

   It defaults to the repo root's name. On a pane that already holds a handle a
   bare `fleet_boss({})` is a query, not a claim: it prints the existing one and
   changes nothing. If it fails, another pane is orchestrating this checkout —
   claim a distinct name with `fleet_boss({ name: "<name>" })` rather than
   stealing it.
2. **`docs/agents/issue-tracker.md`.** It is the only thing that knows how to
   list issues, read dependencies, comment, and close in this repo. If it is
   missing, the repo was never set up: stop and tell the user this repo needs
   `skill://setup-matt-pocock-skills` run first. Do not substitute a `gh`
   command you invented — this tracker may not be GitHub.

If `docs/agents/triage-labels.md` exists, read it — it maps the canonical
role names below to the strings this repo actually uses. Setup writes that
file only when the `triage` skill is installed; if it is missing, use the
five canonical names as they are: `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`.

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
- **Drop anything already claimed.** An assignee means the ticket is
  claimed — by a human, or by another orchestrator's worker — either way it
  is not yours. Call `fleet_ls({})` too — a ticket whose worker is alive from an
  earlier run must not be dispatched twice.
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
| `needs-triage` | Offer to read `skill://triage` here. It is interview work; it stays with you. |
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

That last row is a ticket that *asks* for some existing branch to be reviewed.
You do not need a ticket to review this run's own output — step 6 sends every
branch a worker hands back to a reviewer automatically.

**Two kinds of ticket never reach a worker.**

*Decisions.* A ticket whose deliverable is an answer recorded on the ticket —
not a branch, not a PR — is yours. Resolve it here, using your harness's local
subagents in parallel when available (`scout`, `librarian`, or `task` in omp).
Then record the resolution on the ticket, close it, and update whatever parent
or map indexes it **in the same pass**. An index that lags its tickets is worse
than none. Do these early: a decision the rest of the backlog is shaped around
is worth knowing before you dispatch into it.

*Trivia.* A one-line diff, a version bump, a doc typo. Do it yourself or use a
local subagent and say you did. A branch is more ceremony than the change.

## 3. Close the gaps in one round

`ready-for-agent` means the ticket is specified. It does not mean the specific
answers a given skill stalls without are in the ticket body:

| Kind | Cannot start without |
|---|---|
| implement | the spec inline, or a reference the worker can fetch; the **seams** the `tdd` skill will test at, since it refuses an unconfirmed one; decisions already made — libraries, patterns, code to reuse |
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
the fence in the scope line, and the escalation list in step 7.

Two things decide who is in the wave:

- **The cap.** Three concurrent code workers unless the repo says otherwise. A
  fleet worker is a full agent process, not a local subagent; they are not free,
  and one blocked waiting on your attention is worse than one that starts later.
  The cap counts this wave only — step 6's reviewers run after these have
  settled, so they are not competing for the same slots.
- **File overlap.** Two workers editing the same files produce conflicting
  branches and nothing resolves that for you. Hold the second back and say why.
- **A wave-wide notice.** If a decision changes after workers are already
  dispatched — a contract shifts, a choke-point ticket lands differently than
  planned — `fleet_broadcast({ text })` reaches every live worker in this repo
  in one call, instead of repeating a `fleet_send` per handle.

## 5. Dispatch

Compose every brief as text before spawning anything. Use the shape described
by `skill://fleet-dispatch`: the answers from step 3, then scope and
acceptance. `fleet_spawn`'s `skill` field prepends the skill activation
instruction, so the brief itself starts with its concrete content:

Workers are always omp now, so open the brief's body with the lowercase word
`orchestrate` as its first word — plain prose, not inside backticks. That word
triggers omp's magic-keyword contract: it scopes the full task, delegates
substantial independent work in parallel, verifies each phase, and continues
until the request is complete, from the worker's very first turn.

```markdown

## <Spec | Symptom + Reproduction | Question | Design question | Fixed point>
orchestrate this ticket: <the answers from step 3, in full>

## Scope
<files and modules in play; then the explicit non-goals>

## Done when
<checkable criteria>

## Handoff
Open a PR against <base> when the work is done, move the ticket to review per
this repo's tracker conventions, then `fleet report` with the PR number and one
line on how you proved it. Do not merge — I do that, and my merge is the
approval you are waiting for. A reviewer reads your branch after you report, so
expect change requests and address them in this worktree.
```

That Handoff section is the one thing a backlog brief adds. `fleet`'s own
protocol block tells the worker to commit, report, reply, and stay in its
worktree — never repeat any of that — but it stops short of a PR, and a merge
authority needs one to review. Everything a worker commits is reviewed before
it merges, so the brief says so rather than letting a change request arrive as
a surprise.

Add the context the worker cannot derive: constraints inherited from a parent
epic, and for a choke-point ticket, that it owns a contract other tickets
consume.

Claim each ticket at the moment its worker spawns — not earlier in the
batch, and not with an invented command. The tracker file documents its own
claim mechanism (a GitHub tracker claims with `gh issue edit <n>
--add-assignee @me`); use that one, immediately before the matching
`fleet_spawn` call below. If the spawn fails, release the claim right away so the ticket
is dispatchable again instead of sitting stuck looking taken.

Then spawn the whole wave. Reports and questions arrive on their own from
here — call `fleet_join({})` only if you have nothing else to do and want to
sit until the next one lands:

```
fleet_spawn({ branch: "feat/412-webhook-retry", base: "origin/main", tier: "deep", skill: "implement", task: "orchestrate this ticket: <the brief above>" })
fleet_spawn({ branch: "fix/418-duplicate-send", base: "origin/main", tier: "deep", skill: "diagnosing-bugs", task: "orchestrate this ticket: <the brief above>" })
fleet_join({})
```

Never a chain of `fleet_ask` — that serializes the thing you came here to
parallelize.

Reviewers are the exception to `base`, and step 6 spawns one for every branch
that comes back: the `code-review` skill diffs in its own checkout, so a
reviewer branches off the tip under review rather than off the merge target.

## 6. Collect the wave, then review it

Worker reports and questions now arrive on their own, tagged
`[fleet:<handle>]`, as soon as they land — no blocking call required. If you
do call `fleet_join`, it waits for the whole wave, but not silently and not
uninterruptibly: it prints each worker's result the moment that worker
settles rather than holding all of them until the last one finishes, and it
returns immediately — before the rest of the wave has settled — the instant
any worker files a question with `fleet reply`. Either path gets a blocked
worker in front of you the moment it happens, not only when a `fleet_join`
tool call happens to be outstanding.
Answer with `fleet_send({ handle, text: <answer>, raw: true })` — `raw: true`
sends the answer alone, where the default would re-append fleet's protocol
block onto a one-line reply — then call `fleet_join({})` again; re-joining is
safe and skips workers already marked joined. It is still a wave, not a
rolling queue: you cannot backfill a finished worker's slot while its
siblings are still running, and you should not try.

If `fleet_join` instead reports a worker `blocked` on an approval or question
UI rather than a `fleet reply`, read its pane first — `fleet_read({ handle })`
— then send the keys that clear it — `fleet_keys({ handle, keys: [...] })` —
before joining it again.

When the wave settles, every branch that carries code goes straight back out —
to a `code-review` worker, before you read a line of the diff. Reviewing them
here is the same mistake as fixing them here: you would be reading diffs in the
pane that should be dispatching the next wave, and doing by eye what the skill
runs as two parallel sub-agents (Standards and Spec) in a checkout that already
has the branch. The code workers have settled, so this costs no concurrency —
it is a second wave, not a wider one.

Two kinds of branch skip it. `research` and `prototype` deliver a write-up or a
throwaway spike rather than code to merge — read those yourself. Trivia you did
inline never had a branch.

One reviewer per branch, all spawned before any `fleet_join`. Two different
refs are in play and swapping them wastes a worker: `base` is the **tip under
review**, so the reviewer's checkout contains the work, while the fixed point it
diffs against — the `base` you dispatched the *worker* from, typically
`origin/main` — is a line in the brief text, not a field. Inline the
acceptance criteria too: a reviewer is a fresh agent that may have no tracker
access, so a bare issue number is not a spec.

```
fleet_spawn({ branch: "review/412-webhook-retry", base: "feat/412-webhook-retry", tier: "standard", skill: "code-review", task: "<the review brief>" })
fleet_spawn({ branch: "review/418-duplicate-send", base: "fix/418-duplicate-send", tier: "standard", skill: "code-review", task: "<the review brief>" })
fleet_join({})
```

Each report is committed in its reviewer's worktree — `fleet_ls` prints the
directory. Those `review/*` branches are scratch: read them, never merge them.

An `implement` worker closes by running the `code-review` skill on its own
branch. That is the author reviewing the author; it does not replace this step.
Read it if the worker linked it, but the independent reviewer is the one whose
finding blocks a merge.

Leave each code worker alive until its review clears. `fleet_reap` deletes the
worktree, and a change request needs the worker that wrote the branch, in the
worktree it wrote it in.

## 7. Merge, recompute, repeat

Take each ticket in turn:

1. **Verify against the tracker, the diff, and the review report — never the
   worker's summary of its own work.** The PR exists, CI is green, the ticket is
   at review, the acceptance criteria in the ticket body are met *by the diff*,
   and the reviewer found nothing blocking. A clean review on a red PR is not
   mergeable, and neither is a green PR its reviewer flagged.
2. **Merge the way this repo merges.** Match its history: a repo with one
   logical change per commit and conventional subjects wants a rebase merge, and
   a squash would collapse exactly what it is keeping. Delete the branch.
3. **Confirm the ticket closed,** update any derived parent or epic status,
   mark its todo done, and call `fleet_reap({ handles: [<worker>, <reviewer>] })`
   for **both handles**. `fleet_reap` refuses a dirty worktree — that refusal
   is protecting uncommitted work, so read the diff before reaching for
   `force: true`. If the worktree is already gone, removed by hand outside
   fleet, `fleet_reap({ handles: [<handle>], forget: true })` drops fleet's
   record without touching a worktree that isn't there; without it that
   handle sticks in `fleet_ls` as `gone` forever. The mirror case is a handle
   whose state exists but whose agent died: `fleet_spawn({ branch: <branch>,
   replace: true })` removes the recorded workspace and respawns under the
   same handle, rather than refusing because the record is still there.

Then recompute the frontier from step 1 and dispatch the next wave. Merge the
whole settled wave before recomputing — one merge typically unblocks one or two
tickets, and computing the frontier halfway through leaves them out of it.

**A blocking finding goes back to its worker.** Comment the change request on
the PR, `fleet_send` the worker to address it, move the ticket back. Do not fix
it yourself — you would be reviewing your own patch on the next pass. When the
fix lands, check it against the specific findings yourself; a targeted fix does
not earn a second full review. Re-dispatch a reviewer only when the worker
reworked the approach instead of patching it, re-spawning it with `replace: true`
so it rebuilds off the new tip under the same handle.

**Escalate instead of merging** when CI is red and the worker says it is
unrelated; when a worker and its reviewer disagree about whether an acceptance
criterion is met; when a PR changes a shared contract beyond what its ticket
describes; when a worker reports it could not meet an acceptance criterion; or
when two PRs conflict in a way that needs a scope decision.

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
- **You fill the slots you have.** Every wave takes as many ready, independent,
  non-overlapping tickets as the cap allows. A wave of one is correct when the
  frontier holds one; it is a mistake when three were ready and two are still
  sitting in the queue. Serial dispatch is a slow, expensive `task` loop.
