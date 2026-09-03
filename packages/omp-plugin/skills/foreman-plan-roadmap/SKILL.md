---
name: foreman-plan-roadmap
description: Use when foreman-roadmap turns an initiative's brief into its next slate of projects.
---

# Foreman Plan Roadmap

## Preconditions

None enforced by routing — unlike `foreman-plan`, you are operator-invoked,
never dispatched by the loop, and may run against the same initiative more
than once as its roadmap grows. There is no "bare initiative" requirement:
an initiative you are pointed at may already carry any number of projects.

## Required reads

- The product `Context` doc (`project_context` at the initiative layer):
  architectural decisions, constraints, and domain vocabulary that shape how
  the brief splits into projects.
- Every existing project already attached to the initiative — name, status,
  `startDate`/`targetDate`, and dependency edges — via the
  `initiative_roadmap` op. This is what lets you place new work relative to
  what is already committed, instead of re-proposing it or sequencing blind.

## Procedure

1. Read the product `Context` doc and the initiative's existing roadmap.
   If the brief you were given has no problem statement or shippable scope
   to decompose — not merely short, genuinely absent — this is a stop
   condition; see below.
2. Decompose the brief into shippable increments: each `proposedProject` is
   a project that *ends* — has a defined finish, closes, ships something —
   never an open-ended theme like "Performance" or "Platform Health" that
   never reaches `completed`.
3. For each increment, draft a `ProposedProject`:
   - `key`: short, stable, local to this result.
   - `name`: the project name as it will read in Linear's sidebar.
   - `description`: Linear's one-line summary — orientation for someone
     scanning the initiative, not the brief.
   - `brief`: a real project brief (SPEC §4.7), not a restatement of the
     name. `foreman-plan` reads exactly this document to decompose the
     project into issues — a project without one is unplannable, so a thin
     or missing brief here silently blocks every issue that project would
     otherwise have produced.
4. Sequence with `blockedBy` (sibling `key`s in this same result) and
   `blockedByExisting` (ids of projects already in Linear) for genuine
   prerequisites only — one project's work is a real precondition for
   another's, not merely a preferred reading or delivery order. The
   extension creates a native `dependency` relation for each edge, which is
   what later gates `foreman-plan` off a project until its prerequisites
   ship (SPEC §17.5). The combined graph — this result's edges plus every
   `blockedByExisting` edge into the existing roadmap — must stay a DAG; a
   cycle or a dangling reference drops the whole result.
5. Derive `startDate` from the latest `targetDate` among a project's
   blockers (its own siblings' proposed dates, or the resolved `targetDate`
   of an existing blocker) and `targetDate` from a defensible duration for
   the scope you gave it. Get this reasonably right, not exactly right: the
   extension re-clamps every date against the real blocker dates before
   creating anything, shifting a `startDate` that lands before its blocker
   finishes and preserving the requested duration when it does. That
   clamp is a safety net for arithmetic drift, not a substitute for a
   thought-out sequence.
6. Write `rationale`: one paragraph connecting the initiative's brief to the
   slate you chose, including what the dates were derived from. Logged for
   the operator, never written to Linear.
7. Yield the `RoadmapResult`.

## Output

Fill `RoadmapResult` (`schemas/roadmap-result.json`). The extension creates
each `proposedProjects[]` entry, attaches it to `initiativeId`, sets its
dates, and wires every dependency edge — nothing else. None of the created
projects get issues; a created, approved project becomes a `foreman-plan`
candidate the normal way, the moment it carries zero issues (which it does,
being new).

## Stop conditions

A `BlockRecord` is right only when the initiative's brief itself cannot
support any confident decomposition — no problem statement, no shippable
scope, nothing to split. A *thin* brief is not a stop condition: propose the
smallest honest first project and say so in `rationale` rather than
blocking. Since you have no existing project or issue to attach a
`blocked:*` label to, a block here is logged by the loop rather than written
to Linear (SPEC known gap) — reserve it for cases where proceeding would
mean inventing scope the brief never described.

## Non-goals

- Proposing issues, estimates, or anything below the project level.
  `foreman-plan` decomposes a project's brief into issues once that project
  exists and is approved — this skill stops at the project boundary.
- Gating on `startDate`/`targetDate`, here or anywhere else in Foreman.
  Dates are informational, derived for the operator's timeline view; the
  dependency graph (`blockedBy`/`blockedByExisting`) is the only
  machine-readable sequence anything gates on.
- A dependency edge to express a merely preferred order. `blockedBy` and
  `blockedByExisting` mean "cannot start until," not "would read better
  after." An edge that doesn't reflect a real prerequisite blocks
  `foreman-plan` off a project for no reason.
- Writing `proposedProjects` into Linear yourself, or attaching any of them
  to the initiative — the extension does both.
- Editing the product `Context` doc or any existing project's brief.
  Propose edits as a comment if something is stale; never write to either.
