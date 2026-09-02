---
name: foreman-plan-project
description: Use when foreman-plan turns a bare project's brief into its first slate of Backlog issues.
---

# Foreman Plan Project

## Preconditions

The project is bare: it carries zero issues in any state. Routing enforces
this — you are never dispatched at a project that already has one. There is
no "top up the backlog" mode: a project reaches you exactly once, right after
it is created and approved, unless the operator later empties it back out.

## Required reads

- The project brief (SPEC §4.7): the increment's problem statement and
  success criteria.
- The product `Context` doc, Definition of Done included — architectural
  decisions, constraints, and domain vocabulary that shape how the brief
  splits into issues.

## Procedure

1. Read the project brief and the product `Context` doc. If the brief has no
   problem statement or success criteria to decompose — not merely short,
   genuinely absent — this is a stop condition; see below.
2. Break the brief's scope into agent-sized slices. Use the same scale
   `foreman-refine` estimates against (SPEC §4.6): a slice that would score 5
   or higher is too big for one issue — split it into more than one
   `proposedIssue` rather than proposing one oversized draft.
3. For each slice, draft a `ProposedIssue`:
   - `title`: short, specific, not a restatement of the brief.
   - `type`: the `type:` label it should carry.
   - `description`: the `## Context` body only — prose, no headings. The
     extension renders the SPEC §13.1 template around it from this plus
     `acceptanceCriteria` and the pass's `outOfScope`, so writing the
     headings yourself nests one template inside another. This is a draft,
     not a finished refinement — `foreman-refine` verifies and revises it
     against the actual code before the issue reaches Todo, exactly as it
     already does for intake-drafted issues (SPEC §3.12). Do not restate the
     Definition of Done.
   - `acceptanceCriteria`: draft observable behaviors. `foreman-refine` may
     sharpen these once it reads the code — a rough but honest first pass
     beats an over-specified guess.
   - `proposedPriority`: a real priority when the brief gives you enough to
     judge urgency; `None` only when you truly cannot tell — an issue stuck
     at `None` sits outside the refine funnel until the operator sets one.
   - `proposedEstimate`: a rough Fibonacci call, or `null` when you cannot
     estimate at all. `foreman-refine` re-estimates against the code.
4. Record explicit non-goals in `outOfScope` — scope the brief describes but
   this pass deliberately does not turn into an issue. This also guards a
   *future* planning pass: a project can only go bare again if every issue is
   later canceled or deleted, but when it does, the same `outOfScope` list
   should stop the same non-goals from resurfacing.
5. Set `fullyPlanned` to `true` only when `proposedIssues` plus `outOfScope`
   together account for everything the brief describes. This field is
   informational — Foreman has no durable per-project flag, so a `false`
   here does not schedule a follow-up pass on its own (see Non-goals). Set it
   honestly anyway: it is the operator's signal, reading the loop log or
   `/foreman-status`, that a project was deliberately planned thin.
6. Write `rationale`: one paragraph connecting the brief to the slices you
   chose. This is logged for the operator, not written to Linear.
7. Yield the `PlanResult`.

## Output

Fill `PlanResult` (`schemas/plan-result.json`). The extension creates each
`proposedIssues[]` entry as a new Backlog issue under the project — nothing
else. None of them carry `agent:ready`; they enter the normal refine funnel
the moment the operator sets a priority, the same path every other Backlog
issue takes.

## Stop conditions

A `BlockRecord` is right only when the brief itself cannot support any
confident decomposition — no problem statement, no success criteria, nothing
to split. A *thin* brief is not a stop condition: propose the smallest
honest first slice (even a single spike-sized issue to investigate the
unknown) and set `fullyPlanned: false` rather than blocking. Since you have
no existing issue to attach a `blocked:*` label to, a block here is
logged by the loop rather than written to Linear (SPEC known gap) — reserve
it for cases where proceeding would mean inventing scope the brief never
described.

## Non-goals

- Dedupe against existing issues. Routing only ever dispatches you at a
  project with zero issues, so there is nothing to dedupe against.
- Topping up an already-seeded project's backlog. Once a project carries one
  issue, it never becomes a plan candidate again — this is a one-shot
  bootstrap, not an ongoing buffer to refill. If a project's scope grows
  after its first pass, that is new issues filed the normal way (triage,
  the operator, or `discoveredWork` from implement), not a second plan pass.
- Writing `proposedIssues` into Linear yourself, or setting `agent:ready` on
  any of them — the extension creates the issues; `foreman-refine` is what
  makes one implementable.
- Editing the project brief or the product `Context` doc. Propose edits as a
  comment if something is stale; never write to either.
