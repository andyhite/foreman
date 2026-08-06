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

1. **Research** enough to recommend: what it touches, what the project's
   spec/design docs say (a proposal that violates a stated governing
   principle is an amendment, not a feature — check `docs/` or an
   `AGENTS.md`/`README` pointer), what exists already, rough size. A
   `scout` dispatch is fine for the code side.
2. **Recommend** one of: _accept as task_, _accept as epic_, _reject_,
   _defer_ — with a two-or-three-sentence rationale.
3. **Ask the operator.** Batch the whole grooming session's decisions into
   as few `ask` rounds as possible.
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

## Out of scope

What this deliberately does not do.
```

### Accept as epic

Same rewrite shape (Goal / Shape of the solution / Constraints and
contracts / Acceptance criteria), relabel idea → epic, status stays
`Backlog`. Then break it down — now, or as a scheduled later grooming —
because **an epic without subtasks is not actionable**.

### Reject

Close as not planned with the rationale as a comment; board status
`Rejected` (tracker skill). Rejection is a recorded decision, not a
deletion — it must be findable and re-arguable later.

### Defer

Leave it an idea, comment what information would unblock the decision.

## Breaking down an epic

The quality bar per subtask: independently deliverable as **one PR**,
testable on its own, with a clear seam to its siblings. Order by
dependency. Name the cross-task contracts (interfaces, schemas, ownership)
in the epic body — the epic orchestrator dispatches from them.

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
