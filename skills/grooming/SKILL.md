---
name: grooming
description: Grooming the backlog under the foreman workflow — deciding ideas (accept as task or epic, or reject), re-speccing accepted work, breaking epics into subtask breakdowns, promoting backlog bugs, and sweeping stale board state. Read when grooming ideas, sizing work, or breaking down an epic.
---

# Grooming — where ideas become work, or stop being carried

Grooming is a **decision pass with the operator in the loop**: the agent
researches and recommends, the operator decides, the agent applies. Never
silently accept or reject an idea on the operator's behalf. Tracker
mechanics (labels, statuses, sub-issues) live in the `tracker` skill.

## The sizing rule

**A task without an epic must be tiny**: one small PR, roughly a day or
less, independently testable. Anything larger — multiple PRs, multiple
seams, "and"-shaped scope — is an epic and gets a breakdown before any work
starts. When sizing is arguable, it's an epic; a too-small epic costs a
little ceremony, a too-big task costs an unreviewable PR.

## Grooming ideas

Work oldest-first through `gh issue list --label <labels.idea> --state
open` (read `<labels.idea>` from `.omp/foreman.json`).

Per idea:

1. **Research** enough to recommend: what it touches, what the domain
   glossary at `docs.context` (or the relevant glossaries reached through
   `docs.contextMap`) and the ADRs under `docs.adr` say, what exists already,
   rough size, and whether `docs.outOfScope` already holds this concept under
   a different title — every path comes from `.omp/foreman.json`, and a
   re-proposal is still the same rejected idea. A proposal that violates a
   recorded decision is an amendment, not a feature. A `scout` dispatch is
   fine for the code side.
2. **Recommend** one of: _accept as task_, _accept as epic_, _chart_,
   _reject_, _defer_ — with a two-or-three-sentence rationale. Chart when
   the destination is visible but the decisions needed to reach it are not;
   calling fog an epic only turns guesses into a breakdown.
3. **Grill the operator** (`skill://grilling`): work the session's
   decisions as a frontier and ask the whole frontier in one round, a
   recommended answer attached to every question. Never ask the operator
   something a `scout` dispatch could answer instead — that's a research
   gap, not a decision.
4. **Apply**:

### Accept as task

Rewrite the body from a note into a spec, relabel idea → task, status
`To Do`:

```markdown
## Problem

What is wrong or missing, and why it matters.

## Proposal

The intended change, concretely. Doc/spec references where they bind.

## Acceptance criteria

- Observable outcomes, each one checkable. These are what QA judges against.

## Test seams

Where the tests attach — the boundary being exercised, named as
narrowly as fewer-is-better allows; one seam is ideal. `skill://tdd`
refuses to write a test at an unconfirmed seam, and `skill://dev-loop`
mandates test-first, so a seam not agreed here gets invented by
whoever implements, coupled to whatever they happened to build. Name
it now, with the operator, while the change is still cheap to shape.
If it genuinely can't be named before the code exists, say that
explicitly — it's a real answer, and it tells the implementer to
confirm the seam before writing the first test.

## Out of scope

What this deliberately does not do.
```

### Accept as epic

Same rewrite shape (Goal / Shape of the solution / Constraints and
contracts / Acceptance criteria / Test seams), relabel idea → epic,
status stays `Backlog`. Then break it down — now, or as a scheduled
later grooming — because **an epic without subtasks is not
actionable**.

### Chart

Run `skill://charting` in **chart it** mode on the idea. The original issue
becomes the map: rewrite it to the map shape, relabel idea → epic, add the
`labels.chart` modifier, and leave it at `Backlog`. Create the visible
decision tickets, wire their dependency edges, and dispatch ready research
tickets. It remains a chart until its frontier is empty; only then does
charting hand it back to grooming as an epic whose breakdown can be derived
from settled decisions.

### Reject

Close as not planned with the rationale as a comment; board status
`Rejected` (tracker skill). Rejection is a recorded decision, not a
deletion — it must be findable and re-arguable later.

When the rejection is about a *concept* — not just this particular
issue — also write it to `docs.outOfScope` (`.omp/foreman.json`,
conventionally `.out-of-scope/`), one markdown file per concept, named
for the concept rather than the issue. The same idea comes back under
a different title; a closed issue is only findable if the next
grooming pass happens to guess the words its original author used.
Skip this when `docs.outOfScope` is `null` — the file is optional.

### Defer

Leave it an idea, comment what information would unblock the decision.

## Breaking down an epic

The quality bar per subtask: independently deliverable as **one PR**,
testable on its own, with a clear seam to its siblings. Name the
cross-task contracts (interfaces, schemas, ownership) in the epic body —
the epic orchestrator dispatches from them.

Record the dependency graph as real GitHub issue dependencies, not just
an ordering in prose:

```shell
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by \
  -F issue_id=<blocker-db-id>
```

`issue_id` is the blocker's numeric **database id** — not its
`#number`, not its `node_id`. Passing the wrong one is the failure
everyone hits; get the right value with `gh issue view <n> --json id`.
If the repo doesn't support issue dependencies, fall back to a
`Blocked by: #<n>` line in the subtask body. Either way, this is what
lets `skill://epic-loop` partition subtasks into concurrent tracks by
querying the graph instead of re-reading the epic's prose.

Wide refactors — many call sites touched, no single small boundary —
don't fit the sizing rule as either a tiny task or a normal epic.
Sequence them expand / migrate / contract: expand adds the new form
beside the old; each migration batch moves one block of call sites
onto the new form and is blocked on the expand subtask; contract
deletes the old form and is blocked on every migration batch. Each
batch is independently mergeable, which is what makes the epic
deliverable at all rather than one PR that must land atomically.

Mechanics per subtask (tracker skill): create with the task label, body in
the task shape above, link as a sub-issue of the epic, add to the board at
`To Do`. When the breakdown lands, the epic's derived status becomes
`To Do`.

Follow-on discoveries mid-epic (a missing seam found during integration)
enter the same way: a new subtask, linked, `To Do` — never prose in a
comment someone must remember.

## Grooming bugs

- **Untriaged** (plain bug label, no severity): triage per the
  `bug-triage` skill.
- **Backlog bugs** (lower severities): for each, either promote to `To Do`
  (operator decision — capacity and priority), leave with a note, or — if
  evidence says it's moot — close as not planned with the rationale, status
  `Rejected`.

## Sweeping the board

While grooming, flag anything that smells stale and raise it with the
operator:

- `In Progress` with no matching branch/worktree activity — the session
  died without moving state; reset to `To Do` with a comment.
- `Review` with a closed or merged PR — finish the transition it missed.
- Epics whose derived status disagrees with the board — recompute (tracker
  skill) and fix.
