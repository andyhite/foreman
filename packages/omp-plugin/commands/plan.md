---
description: Decompose a bare project's brief into its first slate of Backlog issues
argument-hint: <PROJECT-ID>
---

Resolve project `$1` via `foreman_linear_read`. Assemble the shared `context`
from the two-layer `Context` digest (§4.7): the product `Context` doc plus
this project's brief.

Gate: none written to Linear, but refuse to dispatch if the project already
carries at least one issue in any state — plan is a one-shot bootstrap for a
bare project, never a top-up (see the `foreman-plan-project` skill's
non-goals). Tell the operator the project already has issues and point them
at `foreman-refine` for individual issues instead.

Dispatch `foreman-plan` through the `task` tool with `agent: foreman-plan`
and the assembled `context`. The extension revises the call to force
`schemaMode: "strict"`; do not set it yourself and do not try to override it.

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
