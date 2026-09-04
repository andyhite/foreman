---
description: Decompose one or more bare projects' briefs into their first slate of Backlog issues
argument-hint: <PROJECT-ID>...
---

<critical>
- ONE `task` call; every passing project its own `tasks[]` entry. NEVER one call per project, NEVER a partial batch: `foreman-*` agents are `blocking: true`, so one call runs N items concurrently and returns all N results on the one channel the extension captures.
- Each task text MUST carry `FOREMAN-PROJECT: <PROJECT-ID>` on its own line; the extension keys result capture on it.
- NEVER set `schemaMode` or `isolated`; the extension forces `schemaMode: "strict"` and strips `isolated`.
- NEVER restate the planning procedure; `foreman-plan-project` is autoloaded.
</critical>

## Resolve

Each project id in `$ARGUMENTS` via `foreman_linear_read` `op:
"project_context"` with `id`: the brief in `digest`, and `hasIssues` for the
gate below.

## Gate (per project)

`hasIssues` false. Plan is a one-shot bootstrap, never a top-up.
Project already has issues → skip it, tell the operator, point them at
`/foreman:refine` for individual issues; dispatch the rest.

## Dispatch

`agent: foreman-plan` per entry. Task text: `FOREMAN-PROJECT: <PROJECT-ID>`
and the project's brief. The extension appends the two-layer `Context`
digest (product `Context` doc + project brief) to the shared `context`
itself.

## After

`PlanResult` → extension creates each `proposedIssues[]` entry as a Backlog
issue under the project and wires every `blockedBy` edge into a native
Linear `blocks` relation; that relation gates a dependent issue in the
implement loop. Every new issue enters Backlog with no `foreman:*` label and
becomes refinable once the operator sets a priority and `foreman-refine`
picks it up.
