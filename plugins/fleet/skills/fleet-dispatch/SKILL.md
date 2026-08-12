---
name: fleet-dispatch
description: How an orchestrator turns requirements into a fleet worker brief that runs a specific mattpocock/skills skill. Use when dispatching implementation, diagnosis, research, prototyping, or review to a peer agent, or when a /fleet:* command asks for the dispatch contract.
user-invocable: false
---

# Fleet dispatch

You are the project manager, not the implementer.

Your job is to *know what is wanted* and to *say it precisely enough that a
stranger could build it*. A fleet worker is exactly that stranger: a blank
agent process with no memory of this conversation, no access to your context,
and no way to guess. Everything it needs travels in one block of text.

This skill is the contract for writing that text. Read `skill://fleet` for
the CLI contract underneath it.

## The split

Requirements work is interactive — it needs the user in the room — so it stays
with you. Execution work is autonomous and wants its own branch, so it goes to a
worker.

| Stays with you (the orchestrator) | Goes to a worker |
|---|---|
| `skill://grill-me`, `skill://grill-with-docs` — interviewing the user | `skill://implement` — build the spec or tickets |
| `skill://to-spec`, `skill://to-tickets` — turning the conversation into work | `skill://diagnosing-bugs` — reproduce, fix, regression-test |
| `skill://triage`, `skill://wayfinder` — shaping the backlog | `skill://research` — investigate and write up |
| `skill://domain-modeling`, `skill://codebase-design` — deciding the shape | `skill://prototype` — throwaway answer to a design question |
| Reviewing branches, answering `[fleet:*]` questions, merging | `skill://code-review` — two-axis review of a branch |

If you catch yourself editing source files, you have stopped orchestrating.
Dispatch it.

Concurrency is the whole point. Slices that do not depend on each other are
spawned **before** anything is joined. A slice that fits in this checkout stays
here or uses the orchestrator harness's local subagent mechanism (`task` in omp).

## The requirements gate

Do not dispatch a brief you could not defend. Before writing one, you must be
able to state, without hedging:

- what "done" looks like, in terms someone could check
- which files, modules, or seams are in scope — and which are explicitly not
- every decision already made, so the worker does not re-litigate it

If any of those is fuzzy, that is a question for the user, not for the worker.
Read `skill://grilling` to interview them until it is sharp. One clarifying
round now is cheaper than a worker that builds the wrong thing for an hour.

The exception is a decision the worker is *better placed* to make because it
depends on what the code turns out to look like. Say so explicitly in the brief
and tell the worker to `fleet reply` if it needs you to choose.

## Anatomy of a brief

Three sections. Nothing else. The skill invocation does not belong in the file:
`fleet_spawn`'s `skill` field prepends it deterministically.

```markdown
## <what this is>
<the concrete brief: the change, the bug, the question — in full>

## Scope
<files, modules, seams that are in play; then the explicit non-goals>

## Done when
<checkable criteria — a passing test, a file that exists, a behaviour observed>
```

**`skill` is what puts the procedure in front of the worker.** Naming the
skill explicitly is what guarantees the worker works from *that* skill's own
procedure, rather than trusting a blank agent to auto-select the right one
out of a list of forty. Fleet prepends the instruction "Before doing any
other work, read `skill://<name>` and follow it." — omp's own
skill-activation path, since workers are always omp now. Without `skill` you
get a generic agent doing generic work; with it the worker follows the named
skill's own procedure.

**`tier` picks the worker's model band.** Each `/fleet:*` command names the
tier that fits its skill — `standard` for dispatch-heavy work, `deep` when the
worker itself has to hold judgement. `model` is the escape hatch when a boss
needs an omp model selector the tier table does not cover.

`disable-model-invocation: true` lands mostly on the other side of this split
than you would expect. Every one of your own interview skills sets it —
`triage`, `to-tickets`, `to-spec`, `grill-me`, `wayfinder` — while among the
execution skills only `implement` does. So it is mostly *your* menu that is
missing entries, not the worker's: naming a skill and reading it, rather than
expecting to find it in a list, is the same discipline you are asking of the
worker, applied to yourself. `skill://<name>` reads the skill directly and
ignores the field either way.

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

Compose each brief as text, name the execution skill explicitly, and move on
to the next slice:

```
fleet_spawn({ branch: "feat/412-webhook-retry", tier: "deep", skill: "implement", task: "<the brief above>" })
```

`fleet_spawn`'s `task` field is the brief itself — the tool writes it to a
temp file and passes it through, so you never manage `/tmp/fleet-*.md` files
by hand.

Branch names follow the repo's convention if it has one. Otherwise:
`feat/` for new behaviour, `fix/` for defects, `spike/` for prototypes and
research, `review/` for a review pass. The worker's handle is derived from the
branch, so keep branches distinguishable in their first 32 characters.

Claim your own handle with `fleet_boss({})` before the first spawn — a worker
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
cannot write its "Done when" as a short list; split it. A slice is too small if
its branch would be a one-line diff; batch it with a neighbour or do it
yourself.

Two workers touching the same files will produce conflicting branches, and
nothing resolves that for you. Either slice along file boundaries, or accept
that you are merging by hand and say so in both briefs.
