---
name: fleet-dispatch
description: How an orchestrator turns requirements into a fleet worker brief. Use when dispatching work to a peer agent, or when a /fleet:* command asks for the dispatch contract.
user-invocable: false
---

# Fleet dispatch

You are the project manager, not the implementer.

Your job is to *know what is wanted* and to *say it precisely enough that a
stranger could build it*. A fleet worker is exactly that stranger: a blank
agent process with no memory of this conversation, no access to your context,
and no way to guess. Everything it needs travels in one block of text.

This skill is the contract for writing that text. Read
`skill://fleet-orchestrate` for the CLI contract underneath it, and
`skill://fleet-worker` for what a worker itself can do once dispatched.

## The split

Requirements work is interactive — it needs the user in the room — so it
stays with you. Execution work is autonomous and wants its own branch, so it
goes to a worker.

This plugin has no opinion on *how* a worker does its job, and ships no
execution skills of its own. A dispatch may name one configured role, any
number of literal skills, or neither. The role resolves to its configured
skill and appears first in the prompt; literal skills follow in the order
passed. Use a role for a convention reused across dispatches, and literal
skills for procedures specific to this job — see `skill://fleet-orchestrate`.

If you catch yourself editing source files, you have stopped orchestrating.
Dispatch it.

Concurrency is the whole point. Slices that do not depend on each other are
spawned **before** anything is joined. A slice that fits in this checkout
stays here or uses the orchestrator harness's own local subagent mechanism
(`task` in omp).

## The requirements gate

Do not dispatch a brief you could not defend. Before writing one, you must be
able to state, without hedging:

- what "done" looks like, in terms someone could check
- which files, modules, or seams are in scope — and which are explicitly not
- every decision already made, so the worker does not re-litigate it

If any of those is fuzzy, that is a question for the user, not for the
worker. One clarifying round now is cheaper than a worker that builds the
wrong thing for an hour.

The exception is a decision the worker is *better placed* to make because it
depends on what the code turns out to look like. Say so explicitly in the
brief and tell the worker to `fleet reply` if it needs you to choose.

## Anatomy of a brief

Three sections. Nothing else. Role and skill invocations, if any, do not
belong in the file: `fleet_spawn` prepends them deterministically.

```markdown
## <what this is>
<the concrete brief: the change, the bug, the question — in full>

## Scope
<files, modules, seams that are in play; then the explicit non-goals>

## Done when
<checkable criteria — a passing test, a file that exists, a behaviour observed>
```

**A role or skill puts a procedure in front of the worker.** A role selects
one skill through fleet's config; every literal skill is included as named.
Fleet prepends one `skill://<name>` instruction for each, so the worker reads
every required procedure rather than auto-selecting from what happens to be
installed. With neither, the worker works straight from the brief. Which mix
fits is a decision made per dispatch, not something this plugin bakes in.

**`tier` picks the worker's model band.** `standard` for dispatch-heavy work,
`deep` when the worker itself has to hold judgement. `model` is the escape
hatch when an orchestrator needs an omp model selector the tier names don't
cover.

**Do not include:** where to commit, whether to push, how to report back, a
reminder to stay in the worktree, that other workers exist, or a nudge to
delegate independent work. `fleet` appends its own protocol block covering
all of that — including that `fleet ls`/`fleet_ls` lists the other workers
and `fleet dm`/`fleet_dm` reaches one directly over a declared shared seam
(never for status updates), and that substantial independent slices of the
worker's own task should go to its own subagents instead of running
serially. Repeating any of it wastes context and invites contradictions.

**Do not include** a summary of this conversation either. Include the
conclusions, not the deliberation.

## Dispatching

Compose each brief as text, name a configured role, literal skills, or both
when the work calls for them, and move on to the next slice:

```
fleet_spawn({ branch: "feat/412-webhook-retry", tier: "deep", role: "implement", skills: ["tdd", "code-review"], task: "<the brief above>" })
```

Or, with no procedures, a plain task brief:

```
fleet_spawn({ branch: "spike/dashboard-loading-state", tier: "standard", task: "<the brief above>" })
```

`fleet_spawn`'s `task` field is the brief itself — the tool writes it to a
temp file and passes it through, so you never manage `/tmp/fleet-*.md` files
by hand.

Branch names follow the repo's convention if it has one. Otherwise:
`feat/` for new behaviour, `fix/` for defects, `spike/` for throwaway or
exploratory work, `review/` for a review pass. The worker's handle is derived
from the branch, so keep branches distinguishable in their first 32
characters.

Claim your own handle with `fleet_foreman({})` before the first spawn — a worker
stamped with the wrong orchestrator sends its questions to the wrong pane.

Then, once every independent slice is out, keep working. Reports and
questions arrive on their own, tagged `[fleet:<handle>]`, as each worker
settles — no blocking wait required. Answer any of them with
`fleet_send({ handle, text: <answer>, raw: true })` — `raw: true` sends the
answer alone; the default re-appends fleet's protocol block, which fits a
fresh brief and nothing else. Raw answers are steering rather than new
tracked dispatches, so they do not make the eventual report for the worker's
original task look stale. Call `fleet_join({})` only if you have genuinely
nothing else to do and want to sit until the next one lands — it is a
fallback, not the primary way results reach you. Once everyone has reported,
review the branches and tell the user what landed where.

## Sizing a slice

One worker, one branch, one coherent deliverable. A slice is too big if you
cannot write its "Done when" as a short list; split it. A slice is too small
if its branch would be a one-line diff; batch it with a neighbour or do it
yourself.

Two workers touching the same files will produce conflicting branches, and
nothing resolves that for you. Either slice along file boundaries, or accept
that you are merging by hand and say so in both briefs.
