---
name: foreman-plan-roadmap
description: Use when foreman-roadmap turns an initiative's brief into its next slate of projects.
---

# Foreman Plan Roadmap

<critical>
- NEVER write `proposedProjects` to Linear or attach them to the initiative; the extension does both.
- Dependency edge = "cannot start until", never "would read better after". A false edge blocks `foreman-plan` off a project for no reason.
- Combined graph (this result's edges + every `blockedByExisting` edge) MUST be a DAG; a cycle or dangling reference drops the whole result.
- NEVER gate on dates. Dates are informational; the dependency graph is the only machine-readable sequence.
- NEVER edit the product `Context` doc or an existing project's brief; propose edits as a comment.
</critical>

## Preconditions

None enforced by routing. Operator-invoked, never loop-dispatched; MAY run
against the same initiative repeatedly as its roadmap grows. The initiative
MAY already carry any number of projects.

## Required reads

- The product `Context` doc (`project_context`, initiative layer):
  architectural decisions, constraints, domain vocabulary.
- Every project already attached to the initiative (name, status,
  `startDate`/`targetDate`, dependency edges) via the `initiative_roadmap`
  op. This places new work relative to committed work instead of
  re-proposing it or sequencing blind.

## Procedure

1. Read both. Brief has no problem statement or shippable scope (genuinely
   absent, not merely short) → stop condition below.
2. Decompose into shippable increments: each `proposedProject` *ends*
   (defined finish, ships something). NEVER an open-ended theme
   ("Performance", "Platform Health") that never reaches `completed`.
3. Draft each `ProposedProject`:
   - `key`: short, stable, local to this result.
   - `name`: as it reads in Linear's sidebar.
   - `description`: Linear's one-line summary; orientation for someone
     scanning the initiative.
   - `brief`: a real project brief, not a restatement of the name.
     `foreman-plan` reads exactly this to decompose the project; a thin or
     missing brief silently blocks every issue the project would produce.
4. Sequence with `blockedBy` (sibling `key`s) and `blockedByExisting` (ids of
   projects already in Linear) for genuine prerequisites only. The extension
   creates a native `dependency` relation per edge; that relation gates
   `foreman-plan` off a project until prerequisites ship.
5. `startDate` = latest `targetDate` among blockers (siblings' proposed
   dates, or an existing blocker's resolved `targetDate`); `targetDate` =
   `startDate` + defensible duration. Reasonable, not exact: the extension
   re-clamps every date against real blocker dates, shifting an early
   `startDate` and preserving the requested duration. The clamp catches
   arithmetic drift; it does not replace a thought-out sequence.
6. `rationale`: one paragraph, brief → slate, including what the dates
   derive from. Logged, never written to Linear.
7. Yield `RoadmapResult`.

## Output

`RoadmapResult` (`schemas/roadmap-result.json`). The extension creates each
`proposedProjects[]` entry, attaches it to `initiativeId`, sets dates, wires
every dependency edge; nothing else. Created projects get no issues; a
created, approved project becomes a `foreman-plan` candidate the normal way
(zero issues).

## Stop conditions

`BlockRecord` ONLY when the brief cannot support any confident
decomposition: no problem statement, no shippable scope. Thin ≠ block:
propose the smallest honest first project and say so in `rationale`. No
project or issue exists to label, so a block here is logged by the loop, not
written to Linear; reserve it for cases where proceeding means inventing
scope.

## Non-goals

- Issues, estimates, or anything below the project level; `foreman-plan`
  decomposes a project once it exists and is approved.
