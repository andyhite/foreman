---
name: foreman-plan-project
description: Use when foreman-plan turns a bare project's brief into its first slate of Backlog issues.
---

# Foreman Plan Project

<critical>
- NEVER write `proposedIssues` to Linear or set `agent:ready`; the extension creates them, `foreman-refine` readies them.
- `blockedBy` = real prerequisite only. Graph MUST be a DAG: a cycle, duplicate `key`, self-block, or `blockedBy` naming no sibling `key` drops the whole result.
- NEVER put `##` headings in `description`; the extension renders the template.
- NEVER edit the project brief or the product `Context` doc; propose edits as a comment.
</critical>

## Preconditions

Project is bare: zero issues in any state. Routing enforces this. No "top up"
mode: a project reaches you exactly once, right after creation and approval,
unless the operator later empties it.

## Required reads

- The project brief: problem statement and success criteria.
- The product `Context` doc, Definition of Done included: architectural
  decisions, constraints, domain vocabulary.

## Procedure

1. Read both. Brief has no problem statement or success criteria (genuinely
   absent, not merely short) → stop condition below.
2. Split scope into agent-sized slices on `foreman-refine`'s scale. A slice
   scoring ≥5 → split into several `proposedIssues`.
3. Draft each `ProposedIssue`:
   - `key`: short, stable, unique within this result (e.g. `schema`, `api`,
     `ui`). Local only; Linear assigns the real identifier. Siblings'
     `blockedBy` reference it.
   - `title`: short, specific, not a restatement of the brief.
   - `type`: the `type:` label.
   - `description`: `## Context` body only; prose, no headings. A draft:
     `foreman-refine` verifies it against the code before Todo. NEVER
     restate the Definition of Done.
   - `acceptanceCriteria`: draft observable behaviors. Rough and honest beats
     over-specified guess; refine sharpens them.
   - `proposedPriority`: a real priority when the brief supports a judgment;
     `None` only when you truly cannot tell. `None` parks the issue outside
     the refine funnel until the operator sets one.
   - `proposedEstimate`: rough Fibonacci, or `null`. Refine re-estimates.
   - `blockedBy`: sibling `key`s whose work MUST exist first. Empty for
     anything startable now; at least one entry SHOULD be startable.
     Cannot reference an issue outside this result; a dependency on prior
     work is the operator's to wire.
4. Record explicit non-goals in `outOfScope`: scope the brief describes that
   this pass deliberately skips. Also guards a future pass should the
   project go bare again.
5. `fullyPlanned: true` ONLY when `proposedIssues` + `outOfScope` account for
   the whole brief. Informational: no durable flag, no follow-up pass
   scheduled; the operator reads it in the loop log or `/foreman:status`.
6. `rationale`: one paragraph, brief → slices. Logged, never written to Linear.
7. Yield `PlanResult`.

## Output

`PlanResult` (`schemas/plan-result.json`). The extension creates each
`proposedIssues[]` entry as a Backlog issue under the project and wires each
`blockedBy` edge into a native Linear `blocks` relation; nothing else. The
relation, not a label or prose, is what the implement gate reads, so a
prerequisite that never becomes a `blockedBy` entry gates nothing. No issue
gets `agent:ready`; each enters the refine funnel when the operator sets a
priority.

## Stop conditions

`BlockRecord` ONLY when the brief cannot support any confident
decomposition: no problem statement, no success criteria. Thin ≠ block:
propose the smallest honest first slice (even one spike-sized issue) and set
`fullyPlanned: false`. No issue exists to label, so a block here is logged by
the loop, not written to Linear; reserve it for cases where proceeding means
inventing scope.

## Non-goals

- Deduping against existing issues; there are none.
- Topping up a seeded project. Scope growth after the first pass = new
  issues via triage, the operator, or `discoveredWork`; never a second plan
  pass.
