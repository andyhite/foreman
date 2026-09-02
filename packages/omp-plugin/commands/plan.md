---
description: Decompose one or more bare projects' briefs into their first slate of Backlog issues
argument-hint: <PROJECT-ID>...
---

Resolve each project id in `$ARGUMENTS` via `foreman_linear_read`. Assemble
each one's shared `context` from the two-layer `Context` digest (§4.7): the
product `Context` doc plus that project's brief.

Gate per project id: none written to Linear, but refuse to dispatch a
project that already carries at least one issue in any state — plan is a
one-shot bootstrap for a bare project, never a top-up (see the
`foreman-plan-project` skill's non-goals). Tell the operator that project
already has issues and point them at `foreman-refine` for individual issues
instead; dispatch the rest of the batch normally.

Every project id in `$ARGUMENTS` gets its own `tasks[]` entry, each with
`agent: foreman-plan`, its own assembled `context`, and its own
`FOREMAN-PROJECT: <PROJECT-ID>` marker in the task text — dispatch all of
them in a SINGLE `task` call, never one `task` call per project id and never
a partial batch. Every `foreman-*` agent is `blocking: true`, so one call
with N items runs them concurrently and returns all N structured results on
the one channel the extension can capture; splitting the call loses that.
The extension revises the call to force `schemaMode: "strict"` on every
item; do not set it yourself and do not try to override it.

The agent returns a `PlanResult`; the extension creates each
`proposedIssues[]` entry as a new Backlog issue under the project. Nothing
else changes state — none of the new issues carry `agent:ready`, and none of
them move out of Backlog until the operator sets a priority and
`foreman-refine` picks them up through the normal funnel.

`/foreman:apply`, `/foreman:merge`, `/foreman:unblock`, and `/foreman:status`
are extension code, not agent dispatches; they live in `src/extension.ts`,
not in this commands directory.

Do not restate the planning procedure here — it lives in the
`foreman-plan-project` skill, autoloaded by the `foreman-plan` agent.
